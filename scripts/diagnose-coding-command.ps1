Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$evidence = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.scratch/issue-354/evidence'))
[void][IO.Directory]::CreateDirectory($evidence)
$calls = Join-Path $evidence 'calls.jsonl'
$snapshots = Join-Path $evidence 'snapshots.jsonl'
if ((Test-Path -LiteralPath $calls) -or (Test-Path -LiteralPath $snapshots)) { throw '已有诊断记录，禁止覆盖或追加另一轮结果' }
$oldNodeOptions = $env:NODE_OPTIONS
$oldProbeLog = $env:COREMIND_COMMAND_PROBE_LOG
$preload = [Uri]::new((Join-Path $PSScriptRoot 'probe-python-command.mjs')).AbsoluteUri
$observer = Start-Job -FilePath (Join-Path $PSScriptRoot 'supervise-python.ps1') -ArgumentList $calls, $snapshots, 3600
$testExitCode = 1
try {
    # 先确认外部观察器就绪；这不是测试上限，不改变子命令的 30 秒合同。
    $ready = [Diagnostics.Stopwatch]::StartNew()
    while (!(Test-Path -LiteralPath $snapshots) -and $ready.Elapsed.TotalSeconds -lt 15 -and $observer.State -eq 'Running') { Start-Sleep -Milliseconds 100 }
    $env:NODE_OPTIONS = (($oldNodeOptions + ' --import=' + $preload).Trim())
    $env:COREMIND_COMMAND_PROBE_LOG = $calls
    & npm.cmd run test:engineering -- --maxWorkers=1
    $testExitCode = $LASTEXITCODE
} finally {
    # 只结束本脚本创建的监督任务，原测试及其退出码保持独立。
    Start-Sleep -Milliseconds 500
    Stop-Job -Job $observer -ErrorAction Continue
    Receive-Job -Job $observer -ErrorAction Continue *>&1 | Out-File -LiteralPath (Join-Path $evidence 'observer-output.log') -Encoding utf8
    $metadata = @{ schemaVersion = 1; diagnosticOnly = $true; testExitCode = $testExitCode; observerState = [string]$observer.State; observerStoppedByWrapper = $true; observerReadyObserved = Test-Path -LiteralPath $snapshots; originalCommand = 'npm run test:engineering -- --maxWorkers=1'; originalCommandTimeoutMs = 30000; qualifiesAsEngineering = $false }
    [IO.File]::WriteAllText((Join-Path $evidence 'wrapper.json'), (($metadata | ConvertTo-Json -Depth 8) + "`n"), $utf8)
    Remove-Job -Job $observer -Force -ErrorAction Continue
    $env:NODE_OPTIONS = $oldNodeOptions
    $env:COREMIND_COMMAND_PROBE_LOG = $oldProbeLog
}
exit $testExitCode
