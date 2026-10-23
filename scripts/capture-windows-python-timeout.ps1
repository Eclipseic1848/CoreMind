#requires -Version 7.4
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-RegistryValueSnapshot($Key, [string]$Name, [int]$KeyIndex) {
    $exists = $null -ne $Key -and $Key.GetValueNames() -contains $Name
    [pscustomobject]@{ keyIndex = $KeyIndex; name = $Name; exists = $exists
        kind = $(if ($exists) { $Key.GetValueKind($Name).ToString() } else { $null })
        data = $(if ($exists) { $Key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }) }
}
function Test-RegistryValueEqual($Actual, $Expected) {
    $Actual.exists -eq $Expected.exists -and (-not $Expected.exists -or
        ($Actual.kind -ceq $Expected.kind -and (ConvertTo-Json -InputObject $Actual.data -Compress) -ceq (ConvertTo-Json -InputObject $Expected.data -Compress)))
}
function Restore-RegistryValues($Keys, $Snapshots) {
    foreach ($saved in $Snapshots) {
        if ($saved.keyIndex -ge $Keys.Count) { continue }
        try {
            $key = $Keys[$saved.keyIndex]
            if ($saved.exists) { $key.SetValue($saved.name, $saved.data, [Microsoft.Win32.RegistryValueKind]$saved.kind) }
            else { $key.DeleteValue($saved.name, $false) }
            if (-not (Test-RegistryValueEqual (Get-RegistryValueSnapshot $key $saved.name $saved.keyIndex) $saved)) { throw '恢复读回不一致' }
        } catch { 'restore-{0}-{1}' -f $saved.keyIndex, $saved.name }
    }
}
function Invoke-OriginalCore($Record) {
    $Record.coreStartedAtUtc = [DateTimeOffset]::UtcNow.ToString('o'); $global:LASTEXITCODE = $null
    try {
        npm run test:engineering -- --maxWorkers=1
        if ($null -eq $global:LASTEXITCODE) { throw '核心命令没有退出码' }
        $Record.coreExit = [int]$global:LASTEXITCODE
    } catch {
        $Record.coreError = 'core-exception'; $Record.coreExit = 1
        if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { $Record.coreExit = [int]$global:LASTEXITCODE }
    } finally {
        $Record.originalCoreExit = $global:LASTEXITCODE; $Record.coreFinishedAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
}
function Protect-EvidenceFile([string]$Path, [string]$Name, $Recipient, [string]$PublicDirectory, $Budget) {
    $stream = $null; $bytes = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
        if ($stream.Length -gt 64MB -or $Budget.bytes + $stream.Length -gt 128MB) { throw '证据资源限额' }
        $bytes = [byte[]]::new([int]$stream.Length); $stream.ReadExactly($bytes, 0, $bytes.Length)
        $cms = [Security.Cryptography.Pkcs.EnvelopedCms]::new([Security.Cryptography.Pkcs.ContentInfo]::new($bytes),
            [Security.Cryptography.Pkcs.AlgorithmIdentifier]::new([Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.1.42'), 256))
        $cms.Encrypt($Recipient); $encrypted = $cms.Encode(); $destination = Join-Path $PublicDirectory $Name
        $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $output.Write($encrypted, 0, $encrypted.Length) } finally { $output.Dispose() }
        $Budget.bytes += $stream.Length
        [pscustomobject]@{ name = $Name; sourceName = [IO.Path]::GetFileName($Path); sourceBytes = $stream.Length; bytes = $encrypted.Length
            sha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($encrypted)).ToLowerInvariant()
            sourceSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}
function Test-SafeArtifactDirectory([string]$Directory, $Files) {
    $root = Get-Item -LiteralPath $Directory -Force
    if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
    $entries = @(Get-ChildItem -LiteralPath $Directory -Force)
    $allowed = @('metadata.json') + @($Files | ForEach-Object { $_.name })
    if ($entries.Count -ne $allowed.Count -or @($allowed | Sort-Object -Unique).Count -ne $allowed.Count) { return $false }
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $allowed -cnotcontains $entry.Name) { return $false }
    }
    foreach ($file in $Files) {
        if ($file.name -notmatch '\A[a-zA-Z0-9][a-zA-Z0-9._-]*\.p7m\z' -or $file.bytes -le 0 -or $file.sha256 -notmatch '\A[0-9a-fA-F]{64}\z') { return $false }
        $path = Join-Path $Directory $file.name
        if ((Get-Item -LiteralPath $path).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ine $file.sha256) { return $false }
    }
    return $true
}

$record = [ordered]@{ diagnosticOnly = $true; qualifiesAsEngineering = $false; repairClaim = $false
    run = $env:GITHUB_RUN_ID; attempt = $env:GITHUB_RUN_ATTEMPT; head = $env:GITHUB_SHA
    coreStartedAtUtc = $null; coreFinishedAtUtc = $null; coreExit = $null; originalCoreExit = $null; coreError = $null
    captureQuality = 'not-started'; restorationQuality = 'not-needed'; dumpQuality = 'unknown-not-collected'; cdb = $null; files = @(); issues = @() }
$keys = @(); $snapshots = @(); $readKeys = @(); $hive = $null; $global = $null; $cert = $null; $rsa = $null
$touched = $false; $publicReady = $false; $exitCode = 1; $budget = @{ bytes = 0L }
try {
    # 只在一次性托管 Windows VM 执行；不在本机或共享 runner 设置监控。
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw '运行环境不符' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '缺少管理员权限' }
    $workspace = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
    if ($workspace -ine [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)) { throw '工作区不符' }
    $public = Join-Path $workspace '.scratch/issue-354-spe-public'
    if (Test-Path -LiteralPath $public) { throw '公开输出目录已存在' }
    [void][IO.Directory]::CreateDirectory($public); $publicReady = $true
    $temporary = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    if (-not [IO.Directory]::Exists($temporary) -or $temporary.StartsWith($workspace + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '私有目录位置不符' }
    $private = Join-Path $temporary ('coremind-spe-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($private)
    $acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity.User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $private -AclObject $acl
    $pem = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-timeout-recipient.pem'), [Text.UTF8Encoding]::new($false, $true))
    if ($pem -notmatch '\A\s*-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\s*\z') { throw '只允许单一公钥证书' }
    $der = [Convert]::FromBase64String($Matches[1]); $cert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($der)).ToLowerInvariant() -cne '5d488c1746279dbb6e09bbb7536253fa154569ab19be27081861e861f1d3e8a4' -or $cert.HasPrivateKey) { throw '证书身份不符' }
    $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert)
    if ($null -eq $rsa -or $rsa.KeySize -ne 3072) { throw '公钥规格不符' }
    Add-Type -AssemblyName System.Security.Cryptography.Pkcs
    $recipient = [Security.Cryptography.Pkcs.CmsRecipient]::new([Security.Cryptography.Pkcs.SubjectIdentifierType]::IssuerAndSerialNumber, $cert, [Security.Cryptography.RSAEncryptionPadding]::OaepSHA256)
    $cdb = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Windows Kits/10/Debuggers/x64/cdb.exe'
    try { if ([IO.File]::Exists($cdb)) { $record.cdb = @{ name = 'cdb.exe'; version = (Get-Item -LiteralPath $cdb).VersionInfo.FileVersion; sha256 = (Get-FileHash -LiteralPath $cdb -Algorithm SHA256).Hash.ToLowerInvariant() } } }
    catch { $record.issues += 'cdb-identity-unavailable' }
    $registryPaths = @('SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\python.exe', 'SOFTWARE\Microsoft\Windows NT\CurrentVersion\SilentProcessExit\python.exe')
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
    $readKeys = @($hive.OpenSubKey($registryPaths[0]), $hive.OpenSubKey($registryPaths[1]))
    $global = $hive.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\SilentProcessExit')
    if ($null -ne $readKeys[0] -and (($readKeys[0].GetValueNames() -contains 'Debugger') -or ($readKeys[0].GetValueNames() -contains 'UseFilter') -or $readKeys[0].SubKeyCount -gt 0)) { throw '已有 IFEO 配置冲突' }
    foreach ($key in @($global, $readKeys[1])) {
        if ($null -ne $key -and -not [string]::IsNullOrWhiteSpace([string]$key.GetValue('ModuleIgnoreList'))) { throw '已有忽略模块配置' }
    }
    $snapshots = @(Get-RegistryValueSnapshot $readKeys[0] 'GlobalFlag' 0; foreach ($name in @('ReportingMode', 'IgnoreSelfExits', 'DumpType', 'MaxNumberOfDumpFiles', 'LocalDumpFolder')) { Get-RegistryValueSnapshot $readKeys[1] $name 1 })
    # 未知原配置只读退出，不尝试通用数组类型转换与恢复。
    foreach ($saved in @($snapshots | Where-Object { $_.keyIndex -eq 1 -and $_.exists })) {
        $supported = if ($saved.name -eq 'LocalDumpFolder') { $saved.kind -in @('String', 'ExpandString') -and $saved.data -is [string] }
                     else { $saved.kind -eq 'DWord' -and $saved.data -is [int] }
        if (-not $supported) { throw '已有 SPE 值类型不支持' }
    }
    [IO.File]::WriteAllText((Join-Path $private 'registry-snapshot.json'), (ConvertTo-Json -InputObject $snapshots -Depth 8), [Text.UTF8Encoding]::new($false))
    $flags = 0u; $flagKind = 'DWord'
    if ($snapshots[0].exists) {
        $flagKind = $snapshots[0].kind
        if ($flagKind -eq 'DWord') { $flags = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$snapshots[0].data), 0) }
        elseif ($flagKind -eq 'String' -and $snapshots[0].data -match '\A(?:0x)?[0-9a-fA-F]{1,8}\z') { $flags = [Convert]::ToUInt32(($snapshots[0].data -replace '^0x', ''), 16) }
        else { throw 'GlobalFlag 类型或数据不支持' }
    }
    $flags = $flags -bor 0x200
    $flagData = if ($flagKind -eq 'String') { '0x{0:x8}' -f $flags } else { [BitConverter]::ToInt32([BitConverter]::GetBytes([uint32]$flags), 0) }
    $values = @($flagData, 2, 1, 0, 8, $private)
    $touched = $true
    foreach ($path in $registryPaths) { $keys += $hive.CreateSubKey($path, $true) }
    for ($i = 0; $i -lt $snapshots.Count; $i++) {
        $saved = $snapshots[$i]; $kind = if ($i -eq 0) { $flagKind } elseif ($i -eq 5) { 'String' } else { 'DWord' }
        $expected = [pscustomobject]@{ exists = $true; kind = $kind; data = $values[$i] }
        $keys[$saved.keyIndex].SetValue($saved.name, $expected.data, [Microsoft.Win32.RegistryValueKind]$kind)
        if (-not (Test-RegistryValueEqual (Get-RegistryValueSnapshot $keys[$saved.keyIndex] $saved.name $saved.keyIndex) $expected)) { throw '设置读回不一致' }
    }
    $record.captureQuality = 'armed-not-validated'
    Invoke-OriginalCore $record
    $exitCode = $record.coreExit
} catch {
    $record.issues += 'capture-or-preflight-exception'
    $record.captureQuality = if ($null -eq $record.coreStartedAtUtc) { 'preflight-failed' } else { 'unknown-capture-failed' }
    if ($null -ne $record.coreExit) { $exitCode = $record.coreExit }
}
finally {
    # 每个值独立恢复；一项失败不能阻止其余恢复，也不能替换核心失败码。
    try { if ($touched) { $restoreErrors = @(Restore-RegistryValues $keys $snapshots); $record.issues += $restoreErrors; $record.restorationQuality = if ($restoreErrors.Count -eq 0) { 'restored-readback' } else { 'unknown-restore-failed' } } }
    catch { $record.restorationQuality = 'unknown-restore-failed'; $record.issues += 'restore-exception' }
    foreach ($key in @($keys) + @($readKeys) + @($global, $hive)) { try { if ($null -ne $key) { $key.Dispose() } } catch { $record.issues += 'registry-dispose-unknown' } }
}

try {
if ($null -ne $record.coreStartedAtUtc) {
    $dumps = @([IO.Directory]::GetFiles($private, '*.dmp', [IO.SearchOption]::TopDirectoryOnly) | Sort-Object | Select-Object -First 8)
    $sealedDumps = @()
    foreach ($dump in $dumps) {
        $index = [Array]::IndexOf($dumps, $dump) + 1
        try {
            $sealed = Protect-EvidenceFile $dump ('dump-{0:D2}.dmp.p7m' -f $index) $recipient $public $budget
            $record.files += $sealed
            if ($sealed.sourceBytes -gt 0) { $sealedDumps += [pscustomobject]@{ path = $dump; index = $index } }
        }
        catch { $record.issues += 'dump-unavailable-or-resource-limit'; continue }
    }
    # 先保全全部可读 dump；辅助解码不得先占掉关键原件预算。
    foreach ($sealedDump in $sealedDumps) {
        if ($null -eq $record.cdb -or $budget.bytes -ge 128MB) { continue }
        $dump = $sealedDump.path; $index = $sealedDump.index
        $process = $null; $stdout = $null; $stderr = $null; $copies = $null; $processStarted = $false
        try {
            $info = [Diagnostics.ProcessStartInfo]::new(); $info.FileName = $cdb; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $info.WorkingDirectory = $private
            $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
            $symbols = Join-Path $private 'symbols'; [void][IO.Directory]::CreateDirectory($symbols)
            foreach ($argument in @('-sins', '-nosqm', '-netsyms:no', '-y', $symbols, '-z', $dump, '-c', '~*kL;lm;q')) { $info.ArgumentList.Add($argument) }
            $outPath = Join-Path $private ('cdb-{0:D2}.stdout.txt' -f $index); $errPath = Join-Path $private ('cdb-{0:D2}.stderr.txt' -f $index)
            $stdout = [IO.File]::Create($outPath); $stderr = [IO.File]::Create($errPath)
            $process = [Diagnostics.Process]::new(); $process.StartInfo = $info; $processStarted = $process.Start()
            $copies = @($process.StandardOutput.BaseStream.CopyToAsync($stdout), $process.StandardError.BaseStream.CopyToAsync($stderr))
            if (-not $process.WaitForExit(60000)) { throw 'CDB 超时' }
            if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copies, 1000) -or $process.ExitCode -ne 0) { throw 'CDB 输出不完整' }
        } catch { $record.issues += 'cdb-unavailable-or-incomplete' }
        finally {
            try { if ($processStarted -and -not $process.HasExited) { $process.Kill(); if (-not $process.WaitForExit(5000)) { $record.issues += 'cdb-process-may-remain' } } }
            catch { $record.issues += 'cdb-cleanup-unknown' }
            try { if ($null -ne $copies -and -not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copies, 1000)) { $record.issues += 'cdb-copy-incomplete' } }
            catch { $record.issues += 'cdb-copy-incomplete' }
            try { if ($null -ne $process) { $process.Dispose() }; if ($null -ne $stdout) { $stdout.Dispose() }; if ($null -ne $stderr) { $stderr.Dispose() } }
            catch { $record.issues += 'cdb-dispose-unknown' }
        }
        foreach ($suffix in @('stdout', 'stderr')) {
            try { $record.files += Protect-EvidenceFile (Join-Path $private ('cdb-{0:D2}.{1}.txt' -f $index, $suffix)) ('cdb-{0:D2}.{1}.txt.p7m' -f $index, $suffix) $recipient $public $budget }
            catch { $record.issues += 'cdb-output-unavailable-or-resource-limit' }
        }
    }
    $record.dumpQuality = if ($dumps.Count -eq 0) { 'unknown-no-dump' } else { 'unknown-encrypted-unvalidated' }
}
} catch { $record.issues += 'postcore-exception'; $record.dumpQuality = 'unknown-postcore-failed' }
finally {
    try { if ($null -ne $rsa) { $rsa.Dispose() }; if ($null -ne $cert) { $cert.Dispose() } } catch { $record.issues += 'crypto-dispose-unknown' }
    if ($exitCode -eq 0 -and $record.restorationQuality -eq 'unknown-restore-failed') { $exitCode = 1 }
    try {
        if ($publicReady) {
            [IO.File]::WriteAllText((Join-Path $public 'metadata.json'), (ConvertTo-Json -InputObject $record -Depth 8), [Text.UTF8Encoding]::new($false))
            if (-not (Test-SafeArtifactDirectory $public $record.files)) { throw '公开输出校验失败' }
            [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "safe_artifact=true`n", [Text.UTF8Encoding]::new($false))
        }
    } catch { if ($exitCode -eq 0) { $exitCode = 1 }; [Console]::Error.WriteLine('公开取证输出未授权；原核心非零退出码保持。') }
}
exit $exitCode
