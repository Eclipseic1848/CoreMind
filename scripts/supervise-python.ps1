param([string]$InputLog, [string]$OutputLog, [int]$Seconds = 90, [switch]$SelfCheck)
# 临时阶段观测开始 entry
function Write-CoreMindStartupStage([string]$Stage) {
    # 阶段标记与 snapshots 分离；自检和空输出路径不写入。
    if ($SelfCheck -or [string]::IsNullOrEmpty($OutputLog)) { return }
    try {
        [IO.File]::AppendAllText(($OutputLog + '.startup.tsv'), ($Stage + "`t" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + "`t" + $PID + "`t" + $PSVersionTable.PSVersion.ToString() + "`t" + [Environment]::ProcessPath + "`n"), [Text.UTF8Encoding]::new($false))
    } catch {
        # 标记写入失败保持未知，不改变原观察器的异常语义。
    }
}
Write-CoreMindStartupStage 'script_enter'
# 临时阶段观测结束 entry
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

function Get-ImageSha256([string]$ImagePath) {
    # 使用标准 .NET 流计算，不依赖 PowerShell 命令模块。
    $imageStream = [IO.File]::OpenRead($ImagePath)
    $sha256 = $null
    try {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        [BitConverter]::ToString($sha256.ComputeHash($imageStream)).Replace('-', '').ToLowerInvariant()
    } finally {
        if ($sha256) { $sha256.Dispose() }
        $imageStream.Dispose()
    }
}

# 临时阶段观测开始 native_begin
Write-CoreMindStartupStage 'native_type_begin'
# 临时阶段观测结束 native_begin
if (-not ('CoreMindExitProbe' -as [type])) {
    Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CoreMindExitProbe {
    [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
}
'@
}
# 临时阶段观测开始 native_ready
Write-CoreMindStartupStage 'native_type_ready'
# 临时阶段观测结束 native_ready
function Get-NativeProcessExit([IntPtr]$Handle) {
    $wait = [CoreMindExitProbe]::WaitForSingleObject($Handle, 0)
    if ($wait -eq 258) { return @{ state = 'active' } }
    if ($wait -ne 0) { return @{ state = 'unknown'; waitResult = $wait; nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } }
    [uint32]$code = 0
    if (-not [CoreMindExitProbe]::GetExitCodeProcess($Handle, [ref]$code)) { return @{ state = 'unknown'; waitResult = $wait; nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error() } }
    return @{ state = 'exited'; exitCode = $code }
}

function Select-PythonCandidates($call, $records) {
    @($records | Where-Object {
        $_.ParentProcessId -eq $call.nodePid -and $_.Name -match '^python(?:w|[0-9.]+)?\.exe$' -and
        ([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -ge $call.wallMs
    })
}
if ($SelfCheck) {
    $moment = [DateTime]::UtcNow
    $call = [pscustomobject]@{ nodePid = 7001; wallMs = ([DateTimeOffset]$moment).ToUnixTimeMilliseconds() }
    $records = @(
        [pscustomobject]@{ ProcessId = 1; ParentProcessId = 7001; Name = 'python.exe'; CreationDate = $moment },
        [pscustomobject]@{ ProcessId = 2; ParentProcessId = 7002; Name = 'python.exe'; CreationDate = $moment },
        [pscustomobject]@{ ProcessId = 3; ParentProcessId = 7001; Name = 'node.exe'; CreationDate = $moment },
        [pscustomobject]@{ ProcessId = 4; ParentProcessId = 7001; Name = 'python.exe'; CreationDate = $moment.AddSeconds(-1) }
    )
    $selected = @(Select-PythonCandidates $call $records)
    if ($selected.Count -ne 1 -or $selected[0].ProcessId -ne 1) { throw 'candidate filter self-check failed' }
    'candidate filter self-check passed; no process query executed'
    return
}
if (!$InputLog -or !$OutputLog -or $Seconds -lt 1 -or $Seconds -gt 3600) { throw 'InputLog, OutputLog and Seconds (1..3600) are required' }
function Emit($event) {
    $event.schemaVersion = 1
    $event.wallMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    [IO.File]::AppendAllText($OutputLog, (($event | ConvertTo-Json -Compress -Depth 8) + "`n"), $utf8)
}
$timer = [Diagnostics.Stopwatch]::StartNew()
$readCount = 0
$active = @{}
$images = @{}
$processes = @{}
# 临时阶段观测开始 ready_begin
Write-CoreMindStartupStage 'ready_write_begin'
# 临时阶段观测结束 ready_begin
Emit @{ kind = 'observer_ready'; observerPid = $PID; sampleIntervalMs = 200; maximumSeconds = $Seconds }
# 临时阶段观测开始 ready_written
Write-CoreMindStartupStage 'ready_written'
# 临时阶段观测结束 ready_written
while ($timer.Elapsed.TotalSeconds -lt $Seconds) {
    if (Test-Path -LiteralPath $InputLog) {
        # 共享读取不锁住 Node 写入；只处理带换行的完整记录。
        $stream = [IO.File]::Open($InputLog, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $reader = [IO.StreamReader]::new($stream, $utf8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $end = $text.LastIndexOf("`n")
        if ($end -ge 0) {
            $lines = $text.Substring(0, $end).Split("`n")
            while ($readCount -lt $lines.Count) {
                try { $entry = $lines[$readCount] | ConvertFrom-Json } catch { Emit @{ kind = 'input_parse_error'; line = $readCount + 1 }; $readCount++; continue }
                $readCount++
                if ($entry.kind -eq 'spawn_sync_enter') {
                    if ([int]$entry.nodePid -le 0) { throw 'invalid target Node PID' }
                    $active[$entry.callId] = $entry
                } elseif ($entry.kind -in @('spawn_sync_return', 'spawn_sync_throw')) {
                    if ($entry.kind -eq 'spawn_sync_return') {
                        Emit @{ kind = 'call_pid_binding'; callId = $entry.callId; nodePid = $entry.nodePid; pythonPid = $entry.result.pid; callReturnWallMs = $entry.wallMs }
                    }
                    Emit @{ kind = 'call_end'; callId = $entry.callId; nodePid = $entry.nodePid; sourceKind = $entry.kind }
                    $active.Remove($entry.callId)
                }
            }
        }
    }
    foreach ($call in @($active.Values)) {
        $query = [Diagnostics.Stopwatch]::StartNew()
        try {
            $records = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $([int]$call.nodePid)" -Property ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate, KernelModeTime, UserModeTime -OperationTimeoutSec 1)
            $queryMs = $query.Elapsed.TotalMilliseconds
            $children = @(Select-PythonCandidates $call $records)
            if ($children.Count -eq 0) { Emit @{ kind = 'no_python_candidate_observed'; candidateForCallId = $call.callId; nodePid = $call.nodePid; queryMs = $queryMs } }
            foreach ($child in $children) {
                $key = "$($call.callId):$($child.ProcessId):$($child.CreationDate.Ticks)"
                if (!$processes.ContainsKey($key)) {
                    $observed = $null
                    try {
                        $observed = [Diagnostics.Process]::GetProcessById([int]$child.ProcessId)
                        $null = $observed.Handle
                        $startMs = ([DateTimeOffset]$observed.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
                        if ([Math]::Abs($startMs - ([DateTimeOffset]$child.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()) -gt 1) { throw 'PID creation identity changed' }
                        $processes[$key] = @{ process = $observed; candidateForCallId = $call.callId; nodePid = $call.nodePid; pythonPid = $child.ProcessId; parentPid = $child.ParentProcessId; createdUtc = $child.CreationDate.ToUniversalTime().ToString('o') }
                    } catch { if ($observed) { $observed.Dispose() }; throw }
                }
                $image = $child.ExecutablePath
                if ($image -and !$images.ContainsKey($image)) {
                    $images[$image] = @{ sha256 = $null; fileVersion = $null }
                    try { $images[$image] = @{ sha256 = (Get-ImageSha256 -ImagePath $image); fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($image).FileVersion } }
                    catch { $images[$image].errorType = $_.Exception.GetType().FullName }
                }
                Emit @{ kind = 'python_candidate_snapshot'; candidateForCallId = $call.callId; nodePid = $call.nodePid; pythonPid = $child.ProcessId; parentPid = $child.ParentProcessId; imagePath = $image; imageIdentity = $(if ($image) { $images[$image] } else { $null }); createdUtc = $child.CreationDate.ToUniversalTime().ToString('o'); userCpuMs = [double]$child.UserModeTime / 10000; kernelCpuMs = [double]$child.KernelModeTime / 10000; aliveAtSnapshot = $true; queryMs = $queryMs; observationWorkMs = $query.Elapsed.TotalMilliseconds }
            }
        } catch { Emit @{ kind = 'candidate_snapshot_error'; candidateForCallId = $call.callId; nodePid = $call.nodePid; errorType = $_.Exception.GetType().FullName; queryMs = $query.Elapsed.TotalMilliseconds } }
    }
    # 留住候选进程句柄；调用归属必须由实际返回 PID 和创建区间另行确认。
    foreach ($key in @($processes.Keys)) {
        $record = $processes[$key]
        if (-not $record.process) { continue }
        try {
            $nativeExit = Get-NativeProcessExit -Handle $record.process.Handle
            if ($nativeExit.state -eq 'active') { continue }
            if ($nativeExit.state -eq 'unknown') {
                Emit @{ kind = 'candidate_process_observation_error'; candidateForCallId = $record.candidateForCallId; pythonPid = $record.pythonPid; state = 'unknown'; waitResult = $nativeExit.waitResult; nativeError = $nativeExit.nativeError }
                $record.process.Dispose(); $record.process = $null; continue
            }
            Emit @{ kind = 'python_candidate_exit_observed'; candidateForCallId = $record.candidateForCallId; nodePid = $record.nodePid; pythonPid = $record.pythonPid; parentPid = $record.parentPid; createdUtc = $record.createdUtc; exitCode = $nativeExit.exitCode; exitObservedUtc = [DateTime]::UtcNow.ToString('o') }
            $record.process.Dispose(); $processes.Remove($key)
        } catch { Emit @{ kind = 'candidate_process_observation_error'; candidateForCallId = $record.candidateForCallId; pythonPid = $record.pythonPid; state = 'unknown'; errorType = $_.Exception.GetType().FullName }; $record.process.Dispose(); $record.process = $null }
    }
    Start-Sleep -Milliseconds 200
}
foreach ($record in $processes.Values) { if ($record.process) { $record.process.Dispose() } }
Emit @{ kind = 'observer_end'; elapsedMs = $timer.Elapsed.TotalMilliseconds; unfinishedCallIds = @($active.Keys); boundary = 'not observed does not prove absent; CPU final value is not inferred' }
