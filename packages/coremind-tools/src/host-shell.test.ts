import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHostBashTool, resolveWindowsShell } from "./host-shell.js";

describe("宿主 Shell", () => {
  it("Windows 优先选择 Git 安装目录中的 Bash", () => {
    const gitBash = path.win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
    const shell = resolveWindowsShell(
      {
        PATH: [path.win32.join("C:\\Program Files", "Git", "cmd"), "C:\\Windows\\System32"].join(
          path.win32.delimiter,
        ),
      },
      (candidate) => candidate === gitBash || candidate.endsWith("\\git.exe"),
    );

    expect(shell.command).toBe(gitBash);
    expect(shell.args("echo ok")).toEqual(["--noprofile", "--norc", "-lc", "echo ok"]);
  });

  it("Windows 不选择 WSL 或应用商店中继", () => {
    const shell = resolveWindowsShell(
      {
        PATH: [
          "C:\\Windows\\System32",
          "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps",
        ].join(path.win32.delimiter),
      },
      () => false,
    );

    expect(shell.command.toLowerCase()).not.toContain("system32\\bash.exe");
    expect(shell.command.toLowerCase()).not.toContain("windowsapps\\bash.exe");
    expect(shell.command).toBe("powershell.exe");
    expect(shell.input?.("Write-Output ok")).toContain("Write-Output ok");
  });

  it("通过统一 ProcessRunner 执行命令", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-host-shell-"));
    const tool = createHostBashTool({ cwd });

    const result = await tool.execute(
      "host-shell",
      { command: "node -e \"process.stdout.write('host-ok')\"", timeout: 10 },
      undefined,
    );

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("host-ok"),
    });
  });
});
