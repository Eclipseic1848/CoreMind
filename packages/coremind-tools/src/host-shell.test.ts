import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import {
  createHostBashTool,
  createHostBashToolForEnvironment,
  resolveWindowsShell,
} from "./host-shell.js";

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

  it("通过统一 ProcessRunner 在真实宿主环境执行命令", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-host-shell-"));
    const tool = createHostBashTool({ cwd });

    // 成功路径由独立项目的 60 秒 Harness 约束；产品超时语义由 ProcessRunner 单测独立验证。
    const result = await tool.execute("host-shell", { command: "echo host-ok" }, undefined);

    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("host-ok"),
    });
  });

  it("环境终止能力 probe 失败时不进入宿主命令 Adapter", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-host-shell-probe-"));
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
      probeStatus: "failed",
    });
    const tool = createHostBashToolForEnvironment({ cwd }, environment);

    await expect(
      tool.execute("host-shell-probe", { command: "echo should-not-run" }, undefined),
    ).rejects.toMatchObject({ code: "environment_probe_failed" });
  });
});
