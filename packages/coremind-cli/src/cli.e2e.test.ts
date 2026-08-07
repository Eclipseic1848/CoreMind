import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const mockServerPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "mock-openai-server.mjs",
);
const mockConfigPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "mock-config.yaml",
);
const MOCK_PORT = 8799;

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const result = spawnSync("node", [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: 60_000,
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? -1 };
}

let mockServer: ReturnType<typeof spawn> | undefined;

beforeAll(async () => {
  mockServer = spawn("node", [mockServerPath, String(MOCK_PORT)], { stdio: "ignore" });
  // 等待 server 就绪
  await new Promise((resolve) => setTimeout(resolve, 800));
});

afterAll(() => {
  mockServer?.kill();
});

describe("coremind CLI 端到端", () => {
  it("list-templates 输出 8 个模板", () => {
    const { stdout, code } = runCli(["list-templates"]);
    expect(code).toBe(0);
    for (const id of [
      "translator",
      "blog-writer",
      "code-reviewer",
      "bug-squasher",
      "hr-interviewer",
      "contract-reviewer",
      "weekly-report",
      "customer-triage",
    ]) {
      expect(stdout).toContain(id);
    }
  });

  it("create 生成项目并替换 name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const { code } = runCli(["create", "my-agent", "--template", "translator"], { cwd: dir });
    expect(code).toBe(0);
    const yaml = readFileSync(path.join(dir, "my-agent", "coremind.yaml"), "utf8");
    expect(yaml).toContain("name: my-agent");
    expect(yaml).toContain("description: my-agent");
    expect(existsSync(path.join(dir, "my-agent", ".env.example"))).toBe(true);
  });

  it("create 非法名称退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const { code, stderr } = runCli(["create", "Bad Name", "--template", "translator"], {
      cwd: dir,
    });
    expect(code).toBe(1);
    expect(stderr).toContain("小写字母");
  });

  it("create 未知模板退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const { code } = runCli(["create", "x", "--template", "not-exist"], { cwd: dir });
    expect(code).toBe(1);
  });

  it("doctor 全绿时退出码 0", () => {
    const { code, stdout } = runCli(["doctor"], { env: { DEEPSEEK_API_KEY: "test-key" } });
    expect(code).toBe(0);
    expect(stdout).toContain("全部正常");
  });

  it("run 连接 mock server 输出最终文本（--print）", () => {
    const { stdout, code } = runCli(
      ["run", mockConfigPath, "--prompt", "你好世界测试", "--print"],
      {
        env: { MOCK_PORT: String(MOCK_PORT) },
      },
    );
    expect(code).toBe(0);
    expect(stdout).toContain("mock回复：你好世界测试");
  });

  it("run 不存在的配置文件退出码 1", () => {
    const { code } = runCli(["run", "no-such-file.yaml"]);
    expect(code).toBe(1);
  });

  it("run 非法配置退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const bad = path.join(dir, "bad.yaml");
    require("node:fs").writeFileSync(bad, "version: 1\nagents: not-an-object\n", "utf8");
    const { code, stderr } = runCli(["run", bad]);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("未知命令退出码 1 且打印帮助", () => {
    const { code, stdout } = runCli(["frobnicate"]);
    expect(code).toBe(1);
    expect(stdout).toContain("用法");
  });

  it("run --max-steps 超出上限退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const yaml = path.join(dir, "maxsteps.yaml");
    writeFileSync(
      yaml,
      [
        "version: 1",
        "name: max-steps",
        "provider:",
        "  id: mock",
        "  baseUrl: http://127.0.0.1:8799/v1",
        "  model: mock-model",
        "  apiKey: mock-key",
        "agents:",
        "  a:",
        "    systemPrompt: 助手A",
        "  b:",
        "    systemPrompt: 助手B",
        "workflow:",
        "  - id: s1",
        "    type: call",
        "    agent: a",
        "    input: 第一步",
        "  - id: s2",
        "    type: call",
        "    agent: b",
        "    input: 第二步",
      ].join("\n"),
      "utf8",
    );
    const { code, stderr } = runCli(["run", yaml, "--max-steps", "1"], {
      env: { MOCK_PORT: String(MOCK_PORT) },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("步骤数超过上限");
  });
});
