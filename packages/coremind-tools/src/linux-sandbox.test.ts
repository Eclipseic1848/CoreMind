import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLinuxSandboxConfig,
  createLinuxSandboxedBashTool,
  isSensitiveEnvironmentName,
} from "./linux-sandbox.js";

describe("Linux bash sandbox", () => {
  it("只允许写工作区并拒绝常见凭据", () => {
    const cwd = path.join(path.sep, "workspace", "demo");
    const config = buildLinuxSandboxConfig(cwd, {
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: "secret",
      DATABASE_URL: "secret",
    });
    const workspace = path.resolve(cwd);

    expect(config.filesystem.allowWrite).toEqual([workspace]);
    expect(config.filesystem.denyWrite).toContain(path.join(workspace, ".git"));
    expect(config.credentials?.envVars?.map((item) => item.name)).toEqual([
      "DATABASE_URL",
      "DEEPSEEK_API_KEY",
    ]);
    expect(isSensitiveEnvironmentName("NORMAL_FLAG")).toBe(false);
    expect(isSensitiveEnvironmentName("GITHUB_TOKEN")).toBe(true);
    expect(config.network.allowedDomains).toEqual([]);
  });

  it("串行执行 sandbox 命令，避免共享清理器并发互扰", () => {
    const tool = createLinuxSandboxedBashTool({
      cwd: path.join(path.sep, "workspace", "demo"),
      env: { PATH: "/usr/bin" },
    });

    expect(tool.executionMode).toBe("sequential");
  });

  it.skipIf(process.platform !== "linux")("在 Linux 上阻止写入工作区外", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-sandbox-"));
    const cwd = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    mkdirSync(cwd);
    const tool = createLinuxSandboxedBashTool({ cwd, env: { PATH: process.env.PATH } });

    await expect(
      tool.execute(
        "sandbox-test",
        { command: `printf blocked > ${JSON.stringify(outside)}` },
        undefined,
      ),
    ).rejects.toThrow(/Read-only file system|Command exited with code/);

    expect(existsSync(outside)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("在 Linux 上阻止 bash 联网", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-sandbox-network-"));
    const tool = createLinuxSandboxedBashTool({ cwd, env: { PATH: process.env.PATH } });
    const command = [
      'command -v curl >/dev/null || { echo "CURL_MISSING"; exit 127; }',
      "curl --connect-timeout 3 --max-time 5 --silent --show-error https://example.com >/dev/null",
    ].join("\n");

    const failure = await tool
      .execute("sandbox-network-test", { command, timeout: 10 }, undefined)
      .then(
        () => "NETWORK_ALLOWED",
        (error) => (error instanceof Error ? error.message : String(error)),
      );

    expect(failure).not.toBe("NETWORK_ALLOWED");
    expect(failure).not.toContain("CURL_MISSING");
  });
});
