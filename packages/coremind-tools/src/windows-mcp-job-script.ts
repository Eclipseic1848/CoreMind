// 私有控制管道承载配置，业务字节直接继承原生标准句柄。
export const WINDOWS_MCP_JOB_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$pipe = $null
$status = 1
$compiled = $false
try {
  $name = [Environment]::GetEnvironmentVariable('COREMIND_MCP_OWNER_PIPE')
  if ($name -cnotmatch '^coremind-mcp-owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'control' }
  $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
  $pipe.Connect(5000)
  # 预取消不编译；逐字节读取，避免预读下一条关闭帧。
  $bytes = [byte[]]::new(1048576)
  $count = 0
  while (($next = $pipe.ReadByte()) -ne 10) {
    if ($next -lt 0 -or $count -eq $bytes.Length) { throw 'control' }
    $bytes[$count++] = [byte]$next
  }
  $line = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, 0, $count)
  if ($line -ceq '{"cancel":true}') {
    $bytes = [Text.Encoding]::UTF8.GetBytes('{"type":"closed","activeProcesses":0}' + [char]10)
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
  } else {
  Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
  Add-Type -WarningAction SilentlyContinue -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public static class CoreMindMcpJob {
  static IntPtr job, process, thread;
  static bool assigned;
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveLimit;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
    public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup {
    public int Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr handle, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll")] static extern bool QueryInformationJobObject(IntPtr handle, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr handle, IntPtr target);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr handle, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo info);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  static void Require(bool valid) { if (!valid) throw new InvalidOperationException("owner"); }
  static void Release(ref IntPtr handle) {
    if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
  public static string ReadFrame(Stream stream) {
    byte[] bytes = new byte[1048576];
    int count = 0;
    for (;;) {
      int next = stream.ReadByte();
      if (next < 0) { Require(count == 0); return null; }
      if (next == 10) return new UTF8Encoding(false, true).GetString(bytes, 0, count);
      Require(count < bytes.Length);
      bytes[count++] = (byte)next;
    }
  }
  public static void Send(Stream stream, string frame) {
    byte[] bytes = new UTF8Encoding(false, true).GetBytes(frame + "\n");
    stream.Write(bytes, 0, bytes.Length);
    stream.Flush();
  }
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
      result.Append(c);
      slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  static void Absolute(string value) {
    Require(!String.IsNullOrEmpty(value) && value.IndexOf('\0') < 0);
    Require(System.Text.RegularExpressions.Regex.IsMatch(value, @"^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])"));
    // 合法绝对路径可含短文件名或正斜杠，不要求输入已规范化。
    Path.GetFullPath(value);
  }
  public static void Start(string node, string launcher, string cwd, string servicePipe, Dictionary<string, string> hostEnv) {
    Absolute(node); Absolute(launcher); Absolute(cwd);
    Require(System.Text.RegularExpressions.Regex.IsMatch(servicePipe, @"^coremind-mcp-service-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"));
    string allowed = "|SYSTEMROOT|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|";
    SortedDictionary<string, string> environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (KeyValuePair<string, string> item in hostEnv) {
      Require(Array.IndexOf(allowed.Split('|'), item.Key.ToUpperInvariant()) >= 0);
      Require(item.Value != null && item.Value.IndexOf('\0') < 0);
      environment.Add(item.Key, item.Value);
    }
    environment.Add("COREMIND_MCP_SERVICE_PIPE", servicePipe);
    StringBuilder block = new StringBuilder();
    foreach (KeyValuePair<string, string> item in environment) block.Append(item.Key).Append('=').Append(item.Value).Append('\0');
    block.Append('\0');
    IntPtr nativeEnvironment = Marshal.StringToHGlobalUni(block.ToString());
    IntPtr[] stdio = new IntPtr[3];
    try {
      job = CreateJobObjectW(IntPtr.Zero, null);
      Require(job != IntPtr.Zero);
      ExtendedLimits limits = new ExtendedLimits();
      // 不允许后代 breakaway，最后一个 Job 句柄关闭时终止全部成员。
      limits.Basic.Flags = 0x2000;
      Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
      IntPtr current = GetCurrentProcess();
      for (int i = 0; i < 3; i++) Require(DuplicateHandle(current, GetStdHandle(-10 - i), current, out stdio[i], 0, true, 2));
      Startup startup = new Startup();
      startup.Size = Marshal.SizeOf(typeof(Startup));
      startup.Flags = 0x100;
      startup.Input = stdio[0]; startup.Output = stdio[1]; startup.Error = stdio[2];
      ProcessInfo info;
      // CREATE_SUSPENDED、UNICODE_ENVIRONMENT、NO_WINDOW；入 Job 前不执行目标代码。
      Require(CreateProcessW(node, new StringBuilder(Quote(node) + " " + Quote(launcher)), IntPtr.Zero, IntPtr.Zero, true, 0x08000404, nativeEnvironment, cwd, ref startup, out info));
      process = info.Process; thread = info.Thread;
      Require(AssignProcessToJobObject(job, process));
      assigned = true;
      Require(ResumeThread(thread) != UInt32.MaxValue);
      Release(ref thread);
    } finally {
      foreach (IntPtr handle in stdio) if (handle != IntPtr.Zero) CloseHandle(handle);
      Marshal.FreeHGlobal(nativeEnvironment);
    }
  }
  public static string AwaitCommand(Stream stream) {
    Task<string> command = Task.Run(() => ReadFrame(stream));
    command.ContinueWith(t => GC.KeepAlive(t.Exception), TaskContinuationOptions.OnlyOnFaulted);
    for (;;) {
      if (command.IsCompleted) return command.GetAwaiter().GetResult();
      uint state = WaitForSingleObject(process, 10);
      if (state == 0) return null;
      Require(state == 258);
    }
  }
  public static void Close() {
    try {
      if (process != IntPtr.Zero && !assigned) {
        if (WaitForSingleObject(process, 0) != 0) {
          Require(TerminateProcess(process, 1));
          Require(WaitForSingleObject(process, 4000) == 0);
        }
      }
      if (job != IntPtr.Zero) {
        Require(TerminateJobObject(job, 1));
        Stopwatch deadline = Stopwatch.StartNew();
        for (;;) {
          Accounting info;
          Require(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
          if (info.ActiveProcesses == 0) break;
          Require(deadline.ElapsedMilliseconds < 4000);
          Thread.Sleep(10);
        }
      }
    } finally {
      Release(ref thread); Release(ref process); Release(ref job);
    }
  }
}
'@
  $compiled = $true
  if ($null -eq $line -or $line -notmatch '^\s*\{') { throw 'control' }
  $config = ConvertFrom-Json -InputObject $line
  $keys = @($config.PSObject.Properties.Name)
  if ($keys.Count -eq 1 -and $keys[0] -ceq 'cancel' -and $config.cancel -is [bool] -and $config.cancel) {
    [CoreMindMcpJob]::Send($pipe, '{"type":"closed","activeProcesses":0}')
  } else {
    if ($keys.Count -ne 5) { throw 'control' }
    foreach ($key in @('nodePath','launcherPath','servicePipeName','cwd','hostEnv')) { if ($keys -cnotcontains $key) { throw 'control' } }
    foreach ($key in @('nodePath','launcherPath','servicePipeName','cwd')) { if ($config.$key -isnot [string]) { throw 'control' } }
    if ($config.hostEnv -isnot [PSCustomObject]) { throw 'control' }
    $hostEnv = New-Object -TypeName 'System.Collections.Generic.Dictionary[string,string]' -ArgumentList ([StringComparer]::OrdinalIgnoreCase)
    foreach ($property in $config.hostEnv.PSObject.Properties) {
      if ($property.Value -isnot [string]) { throw 'control' }
      $hostEnv.Add($property.Name, $property.Value)
    }
    [CoreMindMcpJob]::Start($config.nodePath, $config.launcherPath, $config.cwd, $config.servicePipeName, $hostEnv)
    [CoreMindMcpJob]::Send($pipe, '{"type":"job_ready"}')
    $line = [CoreMindMcpJob]::AwaitCommand($pipe)
    if ($null -ne $line) {
      if ($line -notmatch '^\s*\{') { throw 'control' }
      $command = ConvertFrom-Json -InputObject $line
      $keys = @($command.PSObject.Properties.Name)
      if ($keys.Count -ne 1 -or $keys[0] -cne 'close' -or $command.close -isnot [bool] -or !$command.close) { throw 'control' }
    }
    [CoreMindMcpJob]::Close()
    [CoreMindMcpJob]::Send($pipe, '{"type":"closed","activeProcesses":0}')
  }
  }
  $status = 0
} catch {
  if ($compiled) { try { [CoreMindMcpJob]::Close() } catch {} }
  if ($null -ne $pipe -and $pipe.IsConnected) {
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes('{"type":"error"}' + [char]10)
      $pipe.Write($bytes, 0, $bytes.Length)
      $pipe.Flush()
    } catch {}
  }
} finally {
  if ($compiled) { try { [CoreMindMcpJob]::Close() } catch { $status = 1 } }
  if ($null -ne $pipe) { $pipe.Dispose() }
}
exit $status
`;
