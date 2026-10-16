// 私有 Windows MCP Job owner；由固定源码离线生成，普通启动只加载已校验资产。
using System.IO.Pipes;
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

  const int MaxControlBytes = 1048576;
  sealed class Control {
    public bool Cancel, Close;
    public string Node, Launcher, Cwd, ServicePipe;
    public Dictionary<string, string> Environment;
  }
  sealed class ControlReader {
    readonly string source;
    int index;
    public ControlReader(string source) { this.source = source; }
    void White() {
      while (index < source.Length) {
        char c = source[index];
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
        index++;
      }
    }
    bool Take(char token) {
      White();
      if (index >= source.Length || source[index] != token) return false;
      index++;
      return true;
    }
    void Token(char token) { Require(Take(token)); }
    public void End() { White(); Require(index == source.Length); }
    public void Object(Action<string> member) {
      Token('{');
      if (Take('}')) return;
      for (;;) {
        string key = StringValue();
        Token(':');
        member(key);
        if (Take('}')) return;
        // 逗号后必须读取另一个字符串键，不能直接结束对象。
        Token(',');
      }
    }
    static int Hex(char c) {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      throw new InvalidOperationException("owner");
    }
    public string StringValue() {
      Token('"');
      StringBuilder result = new StringBuilder();
      while (index < source.Length) {
        char c = source[index++];
        if (c == '"') {
          string value = result.ToString();
          // 对转义解码后的结果也要求完整代理项对。
          new UTF8Encoding(false, true).GetByteCount(value);
          return value;
        }
        Require(c >= 0x20);
        if (c != '\\') { result.Append(c); continue; }
        Require(index < source.Length);
        char escape = source[index++];
        switch (escape) {
          case '"': case '\\': case '/': result.Append(escape); break;
          case 'b': result.Append('\b'); break;
          case 'f': result.Append('\f'); break;
          case 'n': result.Append('\n'); break;
          case 'r': result.Append('\r'); break;
          case 't': result.Append('\t'); break;
          case 'u':
            Require(source.Length - index >= 4);
            int code = 0;
            for (int i = 0; i < 4; i++) code = code * 16 + Hex(source[index++]);
            result.Append((char)code);
            break;
          default: throw new InvalidOperationException("owner");
        }
      }
      throw new InvalidOperationException("owner");
    }
    public void TrueValue() {
      White();
      Require(source.Length - index >= 4 && String.CompareOrdinal(source, index, "true", 0, 4) == 0);
      index += 4;
    }
  }
  static Control ParseControl(string line, bool closing) {
    Require(line != null);
    Require(new UTF8Encoding(false, true).GetByteCount(line) <= MaxControlBytes);
    ControlReader reader = new ControlReader(line);
    Control value = new Control();
    HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
    reader.Object(key => {
      Require(seen.Add(key));
      if (key == "hostEnv") {
        Dictionary<string, string> environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string[] allowed = { "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP" };
        reader.Object(name => {
          // 保留原生启动段不变，在解析边界先拒绝未知名与大小写别名。
          Require(Array.IndexOf(allowed, name.ToUpperInvariant()) >= 0);
          environment.Add(name, reader.StringValue());
        });
        value.Environment = environment;
      } else if (key == "cancel" || key == "close") {
        reader.TrueValue();
        if (key == "cancel") value.Cancel = true; else value.Close = true;
      } else {
        Require(key == "nodePath" || key == "launcherPath" || key == "cwd" || key == "servicePipeName");
        string text = reader.StringValue();
        if (key == "nodePath") value.Node = text;
        else if (key == "launcherPath") value.Launcher = text;
        else if (key == "cwd") value.Cwd = text;
        else value.ServicePipe = text;
      }
    });
    reader.End();
    if (closing) Require(value.Close && seen.SetEquals(new[] { "close" }));
    else if (value.Cancel) Require(seen.SetEquals(new[] { "cancel" }));
    else Require(seen.SetEquals(new[] { "nodePath", "launcherPath", "cwd", "servicePipeName", "hostEnv" }));
    return value;
  }
  public static int Run(string ownerPipeName) {
    NamedPipeClientStream pipe = null;
    int status = 1;
    try {
      Require(ownerPipeName != null && System.Text.RegularExpressions.Regex.IsMatch(ownerPipeName,
        @"^coremind-mcp-owner-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"));
      pipe = new NamedPipeClientStream(".", ownerPipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
      pipe.Connect(5000);
      // 复用原 C# 单帧读取，不预读下一条 close，不编译预取消分支。
      Control config = ParseControl(ReadFrame(pipe), false);
      if (!config.Cancel) {
        Start(config.Node, config.Launcher, config.Cwd, config.ServicePipe, config.Environment);
        Send(pipe, "{\"type\":\"job_ready\"}");
        string command = AwaitCommand(pipe);
        if (command != null) ParseControl(command, true);
        Close();
      }
      Send(pipe, "{\"type\":\"closed\",\"activeProcesses\":0}");
      status = 0;
    } catch {
      try { Close(); } catch { }
      if (pipe != null && pipe.IsConnected) {
        try { Send(pipe, "{\"type\":\"error\"}"); } catch { }
      }
    } finally {
      try { Close(); } catch { status = 1; }
      if (pipe != null) pipe.Dispose();
    }
    return status;
  }
}
