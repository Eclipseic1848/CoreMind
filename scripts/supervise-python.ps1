param([string]$InputLog, [string]$OutputLog, [int]$Seconds = 90, [switch]$SelfCheck)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [System.Text.UTF8Encoding]::new($false)

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
Emit @{ kind = 'observer_ready'; observerPid = $PID; sampleIntervalMs = 200; maximumSeconds = $Seconds }
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
                    try { $images[$image] = @{ sha256 = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash.ToLowerInvariant(); fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($image).FileVersion } }
                    catch { $images[$image].errorType = $_.Exception.GetType().FullName }
                }
                Emit @{ kind = 'python_candidate_snapshot'; candidateForCallId = $call.callId; nodePid = $call.nodePid; pythonPid = $child.ProcessId; parentPid = $child.ParentProcessId; imagePath = $image; imageIdentity = $(if ($image) { $images[$image] } else { $null }); createdUtc = $child.CreationDate.ToUniversalTime().ToString('o'); userCpuMs = [double]$child.UserModeTime / 10000; kernelCpuMs = [double]$child.KernelModeTime / 10000; aliveAtSnapshot = $true; queryMs = $queryMs; observationWorkMs = $query.Elapsed.TotalMilliseconds }
            }
        } catch { Emit @{ kind = 'candidate_snapshot_error'; candidateForCallId = $call.callId; nodePid = $call.nodePid; errorType = $_.Exception.GetType().FullName; queryMs = $query.Elapsed.TotalMilliseconds } }
    }
    # 留住候选进程句柄；调用归属必须由实际返回 PID 和创建区间另行确认。
    foreach ($key in @($processes.Keys)) {
        $record = $processes[$key]
        try {
            $record.process.Refresh()
            if ($record.process.HasExited) {
                Emit @{ kind = 'python_candidate_exit_observed'; candidateForCallId = $record.candidateForCallId; nodePid = $record.nodePid; pythonPid = $record.pythonPid; parentPid = $record.parentPid; createdUtc = $record.createdUtc; exitCode = $record.process.ExitCode; processExitUtc = $record.process.ExitTime.ToUniversalTime().ToString('o') }
                $record.process.Dispose(); $processes.Remove($key)
            }
        } catch { Emit @{ kind = 'candidate_process_observation_error'; candidateForCallId = $record.candidateForCallId; pythonPid = $record.pythonPid; errorType = $_.Exception.GetType().FullName } }
    }
    Start-Sleep -Milliseconds 200
}
foreach ($record in $processes.Values) { $record.process.Dispose() }
Emit @{ kind = 'observer_end'; elapsedMs = $timer.Elapsed.TotalMilliseconds; unfinishedCallIds = @($active.Keys); boundary = 'not observed does not prove absent; CPU final value is not inferred' }
