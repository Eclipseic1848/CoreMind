using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

// 仅供测试：反射固定 Guard 的纯解析入口，不创建 Job 或连接业务管道。
internal static class CoreMindGuardFixture
{
    private static readonly UTF8Encoding Strict = new UTF8Encoding(false, true);

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        var failed = new List<int>();
        int count = 0;
        try
        {
            if (args.Length != 1 || (args[0] != "parse" && args[0] != "frame"))
                throw new InvalidOperationException();
            byte[] bytes = File.ReadAllBytes(Environment.GetEnvironmentVariable("COREMIND_GUARD_ASSEMBLY"));
            string hash;
            using (var hasher = SHA256.Create())
                hash = BitConverter.ToString(hasher.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            if (hash != Environment.GetEnvironmentVariable("COREMIND_GUARD_SHA256"))
                throw new InvalidOperationException();
            Type type = Assembly.Load(bytes).GetType("CoreMindMcpJob", true);
            MethodInfo method = args[0] == "parse"
                ? type.GetMethod("ParseControl", BindingFlags.NonPublic | BindingFlags.Static)
                : type.GetMethod("ReadFrame", BindingFlags.Public | BindingFlags.Static);
            if (method == null) throw new InvalidOperationException();
            foreach (string row in File.ReadAllLines(Environment.GetEnvironmentVariable("COREMIND_GUARD_CASES"), Strict))
            {
                string[] cells = row.Split(new[] { '\t' });
                if (cells.Length != (args[0] == "parse" ? 5 : 7))
                    throw new InvalidOperationException();
                count++;
                bool accepted = false;
                try
                {
                    accepted = args[0] == "parse" ? CheckParse(method, cells) : CheckFrame(method, cells);
                }
                catch (Exception) { }
                if (!accepted) failed.Add(count);
            }
        }
        catch (Exception) { failed.Add(0); }
        // 只报告一基用例索引，0 表示宿主失败；不回显路径、输入或异常正文。
        Console.WriteLine("{\"cases\":" + count.ToString(CultureInfo.InvariantCulture)
            + ",\"failed\":[" + String.Join(",", failed) + "]}");
        return failed.Count == 0 ? 0 : 1;
    }

    private static bool CheckParse(MethodInfo method, string[] cells)
    {
        bool accepted = false;
        try
        {
            string text = Strict.GetString(Convert.FromBase64String(cells[1]));
            object control = method.Invoke(null, new object[] { text, cells[2] == "1" });
            accepted = control != null;
            if (accepted && cells[4] != "~")
            {
                string expected = Strict.GetString(Convert.FromBase64String(cells[4]));
                accepted = String.Equals((string)control.GetType().GetField("Cwd").GetValue(control),
                    expected, StringComparison.Ordinal);
            }
        }
        catch (Exception) { accepted = false; }
        return accepted == (cells[3] == "1");
    }

    private static bool CheckFrame(MethodInfo method, string[] cells)
    {
        using (var stream = new MemoryStream(Convert.FromBase64String(cells[2]), false))
        {
            if (cells[0] == "pair")
            {
                string first = Strict.GetString(Convert.FromBase64String(cells[3]));
                string second = Strict.GetString(Convert.FromBase64String(cells[4]));
                if (!String.Equals((string)method.Invoke(null, new object[] { stream }), first, StringComparison.Ordinal))
                    return false;
                if (stream.Position != Int64.Parse(cells[5], CultureInfo.InvariantCulture)) return false;
                if (!String.Equals((string)method.Invoke(null, new object[] { stream }), second, StringComparison.Ordinal))
                    return false;
                if (stream.Position != Int64.Parse(cells[6], CultureInfo.InvariantCulture)) return false;
                return method.Invoke(null, new object[] { stream }) == null;
            }

            object result = null;
            string failure = "";
            try { result = method.Invoke(null, new object[] { stream }); }
            catch (Exception error)
            {
                while (error.InnerException != null) error = error.InnerException;
                failure = error.GetType().Name;
            }
            if (cells[4] == "-")
            {
                if (failure != "") return false;
                if (cells[3] == "~")
                {
                    if (result != null) return false;
                }
                else
                {
                    string expected = Strict.GetString(Convert.FromBase64String(cells[3]));
                    if (result == null || !String.Equals((string)result, expected, StringComparison.Ordinal))
                        return false;
                }
            }
            else if (failure != cells[4]) return false;
            return stream.Position == Int64.Parse(cells[5], CultureInfo.InvariantCulture);
        }
    }
}
