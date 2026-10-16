// 私有控制管道承载配置；程序集按实际读取的同一字节数组校验后加载。
export const WINDOWS_MCP_JOB_SCRIPT = `
$ErrorActionPreference = 'Stop'
$status = 1
try {
  $guardPath = [Environment]::GetEnvironmentVariable('COREMIND_MCP_GUARD_ASSEMBLY')
  $expectedHash = [Environment]::GetEnvironmentVariable('COREMIND_MCP_GUARD_SHA256')
  if ($expectedHash -cnotmatch '^[0-9a-f]{64}$') { throw 'asset' }
  $guardBytes = [IO.File]::ReadAllBytes($guardPath)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actualHash = [BitConverter]::ToString($sha.ComputeHash($guardBytes)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($actualHash -cne $expectedHash) { throw 'asset' }
  [void][Reflection.Assembly]::Load($guardBytes)
  $status = [CoreMindMcpJob]::Run([Environment]::GetEnvironmentVariable('COREMIND_MCP_OWNER_PIPE'))
} catch { }
exit $status
`;
