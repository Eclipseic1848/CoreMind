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
    const args = shell.args("Write-Output ok");
    expect(args).toContain("-EncodedCommand");
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toContain("Write-Output ok");
    expect(shell.input).toBeUndefined();
  });

  it("Windows 兼容 Path 键并从标准安装根目录寻找 Git Bash", () => {
    const localAppData = "C:\\Users\\tester\\AppData\\Local";
    const gitBash = path.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe");
    const shell = resolveWindowsShell(
      {
        Path: ["", '"C:\\Tools"', ""].join(path.win32.delimiter),
        ProgramW6432: "C:\\Program Files",
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: localAppData,
      },
      (candidate) => candidate === gitBash,
    );

    expect(shell.command).toBe(gitBash);
  });

  it("Windows 空环境明确回退 PowerShell", () => {
    expect(resolveWindowsShell({}, () => false).command).toBe("powershell.exe");
  });

  it("未显式提供环境时仍能构造顺序执行工具", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-host-shell-default-"));

    expect(createHostBashTool({ cwd }).executionMode).toBe("sequential");
  });

  it("通过统一 ProcessRunner 执行命令", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-host-shell-"));
    const env = process.platform === "win32" ? windowsPowerShellEnvironment() : undefined;
    const tool = createHostBashTool({ cwd, env });
    const command = process.platform === "win32" ? "Write-Output 'host-ok'" : "printf 'host-ok'";

    // 成功路径由项目级 15 秒 Harness 约束；产品超时语义由 ProcessRunner 单测独立验证。
    const result = await tool.execute("host-shell", { command }, undefined);

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("host-ok"),
    });
  });
});

function windowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const searchPath = [
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    path.win32.join(systemRoot, "System32"),
  ].join(path.win32.delimiter);
  return {
    PATH: searchPath,
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR ?? systemRoot,
    COMSPEC: process.env.COMSPEC ?? path.win32.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };
}
