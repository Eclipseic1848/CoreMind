import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHostBashTool, resolveWindowsShell } from "./host-shell.js";

describe("宿主 Shell", () => {
  it.skipIf(process.platform !== "win32")("Windows 不选择 WSL 中继 bash.exe", () => {
    const shell = resolveWindowsShell(process.env);

    expect(shell.command.toLowerCase()).not.toContain("system32\\bash.exe");
    expect(shell.command.toLowerCase()).not.toContain("windowsapps\\bash.exe");
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
