import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildLinuxSandboxConfig,
  createLinuxSandboxedBashTool,
  isSensitiveEnvironmentName,
  shutdownLinuxSandbox,
} from "./linux-sandbox.js";
import { wrapLinuxSandboxCommand } from "./linux-sandbox-backend.js";

describe("Linux bash sandbox", () => {
  afterAll(() => shutdownLinuxSandbox());
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

  it("拒绝把断网后端配置为网络允许列表", async () => {
    const config = buildLinuxSandboxConfig(path.join(path.sep, "workspace"), {});
    config.network.allowedDomains.push("example.com");
    await expect(wrapLinuxSandboxCommand("true", config)).rejects.toThrow("严格断网");
  });

  it("已取消的命令在创建原生资源前退出", async () => {
    const controller = new AbortController();
    controller.abort(new Error("已取消"));
    await expect(
      wrapLinuxSandboxCommand("true", buildLinuxSandboxConfig(path.sep, {}), controller.signal),
    ).rejects.toThrow("已取消");
  });

  it.skipIf(process.platform !== "linux")(
    "保留工作区写入并拒绝凭据符号链接与受保护写入",
    async () => {
      const root = mkdtempSync(path.join(tmpdir(), "coremind-sandbox-files-"));
      const cwd = path.join(root, "workspace");
      mkdirSync(cwd);
      const secret = path.join(root, "secret.txt");
      writeFileSync(secret, "sandbox-test-secret", "utf8");
      symlinkSync(secret, path.join(cwd, ".env"));
      mkdirSync(path.join(cwd, ".git"));
      const protectedFile = path.join(cwd, ".git", "protected.txt");
      writeFileSync(protectedFile, "unchanged", "utf8");
      const tool = createLinuxSandboxedBashTool({ cwd, env: { PATH: process.env.PATH } });
      await tool.execute("write", { command: "printf allowed > result.txt" }, undefined);
      expect(readFileSync(path.join(cwd, "result.txt"), "utf8")).toBe("allowed");
      await expect(
        tool.execute("deny-write", { command: "printf forbidden > .git/protected.txt" }, undefined),
      ).rejects.toThrow();
      expect(readFileSync(protectedFile, "utf8")).toBe("unchanged");
      const result = await tool.execute("deny-read", { command: "cat .env" }, undefined);
      expect(JSON.stringify(result)).not.toContain("sandbox-test-secret");
    },
  );

  it.skipIf(process.platform !== "linux")("保留 AF_UNIX 拒绝且不建立本地代理", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-sandbox-socket-"));
    const tool = createLinuxSandboxedBashTool({ cwd, env: { PATH: process.env.PATH } });
    const code =
      "const s=require('node:net').createServer();s.on('error',()=>process.exit(0));s.listen('blocked.sock',()=>process.exit(9))";
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    await tool.execute(
      "unix-socket",
      { command: `${quote(process.execPath)} -e ${quote(code)}`, timeout: 5 },
      undefined,
    );
    expect(existsSync(path.join(cwd, "blocked.sock"))).toBe(false);
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
