using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

internal static class CoreMindMcpConsoleHost {
  public static int Main() {
    int status = 1;
    try {
      string guardPath = Environment.GetEnvironmentVariable("COREMIND_MCP_GUARD_ASSEMBLY");
      string expectedHash = Environment.GetEnvironmentVariable("COREMIND_MCP_GUARD_SHA256");
      if (expectedHash == null || !Regex.IsMatch(expectedHash, "^[0-9a-f]{64}$"))
        throw new InvalidDataException("asset");
      byte[] guardBytes = File.ReadAllBytes(guardPath);
      string actualHash;
      using (SHA256 sha = SHA256.Create()) {
        actualHash = BitConverter.ToString(sha.ComputeHash(guardBytes)).Replace("-", "").ToLowerInvariant();
      }
      if (!String.Equals(actualHash, expectedHash, StringComparison.Ordinal))
        throw new InvalidDataException("asset");
      Assembly guard = Assembly.Load(guardBytes);
      // 从已核验的同一程序集取入口，避免编译期引用触发提前加载。
      MethodInfo run = guard.GetType("CoreMindMcpJob", true).GetMethod(
        "Run", BindingFlags.Public | BindingFlags.Static, null, new Type[] { typeof(string) }, null);
      status = (int)run.Invoke(null, new object[] {
        Environment.GetEnvironmentVariable("COREMIND_MCP_OWNER_PIPE")
      });
    } catch { }
    return status;
  }
}
