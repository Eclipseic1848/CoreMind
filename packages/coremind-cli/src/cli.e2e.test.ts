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
const mockConfigFixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "mock-config.yaml",
);
const mockProjectDirectory = mkdtempSync(path.join(tmpdir(), "coremind-cli-fixture-"));
const mockConfigPath = path.join(mockProjectDirectory, "coremind.yaml");
writeFileSync(mockConfigPath, readFileSync(mockConfigFixturePath, "utf8"), "utf8");
const MOCK_PORT = 8799;

function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): {
  stdout: string;
  stderr: string;
  code: number;
} {
  const result = spawnSync("node", [cliPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    input: options.input,
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
  it("--version 输出版本号（验证安装）", () => {
    const { stdout, code } = runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/coremind v\d+\.\d+\.\d+/);
  });

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

  it("templates 是 list-templates 的易发现别名", () => {
    const { stdout, code } = runCli(["templates"]);
    expect(code).toBe(0);
    expect(stdout).toContain("translator");
  });

  it("create 生成项目并替换 name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const { code } = runCli(
      ["create", "my-agent", "--template", "translator", "--language", "typescript"],
      { cwd: dir },
    );
    expect(code).toBe(0);
    const yaml = readFileSync(path.join(dir, "my-agent", "coremind.yaml"), "utf8");
    expect(yaml).toContain("name: my-agent");
    expect(yaml).toContain("description: my-agent");
    expect(existsSync(path.join(dir, "my-agent", ".env.example"))).toBe(true);
    expect(existsSync(path.join(dir, "my-agent", "skills", "project-agent", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(dir, "my-agent", "docs", "development-sop.en.md"))).toBe(true);
  });

  it("create 非法名称退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const { code, stderr } = runCli(
      ["create", "Bad Name", "--template", "translator", "--language", "typescript"],
      { cwd: dir },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("小写字母");
  });

  it("create 未知模板退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const { code } = runCli(
      ["create", "x", "--template", "not-exist", "--language", "typescript"],
      { cwd: dir },
    );
    expect(code).toBe(1);
  });

  it("create 接入已有 JavaScript 工程时自动检测语言且不覆盖 README", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-existing-"));
    writeFileSync(path.join(dir, "package.json"), '{"name":"existing"}', "utf8");
    writeFileSync(path.join(dir, "README.md"), "用户原有说明", "utf8");

    const { code, stdout } = runCli(["create", ".", "--template", "translator"], { cwd: dir });

    expect(code).toBe(0);
    expect(stdout).toContain("javascript");
    expect(readFileSync(path.join(dir, "README.md"), "utf8")).toBe("用户原有说明");
    expect(existsSync(path.join(dir, "src", "tools", "example.js"))).toBe(true);
  });

  it("check 对脚手架完整的 standard 项目返回通过", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-check-e2e-"));
    const created = runCli(
      ["create", "checked-agent", "--template", "translator", "--language", "typescript"],
      { cwd: dir },
    );
    expect(created.code).toBe(0);

    const projectDir = path.join(dir, "checked-agent");
    const checked = runCli(["check", "coremind.yaml"], { cwd: projectDir });
    expect(checked.code).toBe(0);
    expect(checked.stdout).toContain("质量门禁通过");
  });

  it("check 不允许用覆盖原因绕过明文密钥", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-check-secret-e2e-"));
    const configPath = path.join(dir, "coremind.yaml");
    writeFileSync(
      configPath,
      [
        "schemaVersion: 2",
        "name: unsafe",
        "provider:",
        "  id: unsafe",
        "  baseUrl: http://127.0.0.1:8799/v1",
        "  model: mock-model",
        "  apiKey: plaintext",
        "agents:",
        "  main:",
        "    systemPrompt: 测试",
        "runtime: {}",
        "permissions:",
        "  mode: ask",
        "  workspaceOnly: true",
        "  network: ask",
        "quality:",
        "  profile: development",
      ].join("\n"),
      "utf8",
    );

    const checked = runCli(["check", configPath, "--override-reason", "临时接受风险"], {
      cwd: dir,
    });
    expect(checked.code).toBe(1);
    expect(checked.stdout + checked.stderr).toContain("SECURITY_PLAINTEXT_KEY");
  });

  it("eval 使用真实 Runtime 运行场景并输出发布判断", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-eval-e2e-"));
    const suitePath = path.join(dir, "scenarios.yaml");
    writeFileSync(
      suitePath,
      [
        "schemaVersion: 1",
        "scenarios:",
        "  - id: greeting",
        "    input: 评测输入",
        "    expected:",
        "      contains:",
        "        - mock回复：评测输入",
      ].join("\n"),
      "utf8",
    );

    const evaluated = runCli(["eval", mockConfigPath, "--suite", suitePath], {
      cwd: dir,
      env: { MOCK_PORT: String(MOCK_PORT) },
    });
    expect(evaluated.code).toBe(0);
    expect(evaluated.stdout).toContain("1/1");
    expect(evaluated.stdout).toContain("达到评测门槛");
  });

  it("doctor 全绿时退出码 0", () => {
    const { code, stdout } = runCli(["doctor"], { env: { DEEPSEEK_API_KEY: "test-key" } });
    expect(code).toBe(0);
    expect(stdout).toContain("全部正常");
  });

  it("doctor 自动加载 cwd 下的 .env（copy .env.example .env 流程）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    writeFileSync(path.join(dir, ".env"), "DEEPSEEK_API_KEY=from-dotenv\n", "utf8");
    const { code, stdout } = runCli(["doctor"], { cwd: dir });
    expect(code).toBe(0);
    // .env 已加载：DEEPSEEK_API_KEY 不应出现在"未配置"清单里
    expect(stdout).not.toContain("未配置：DEEPSEEK_API_KEY");
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

  it("run 默认模式输出质量摘要", () => {
    const { stdout, code } = runCli(["run", mockConfigPath, "--prompt", "质量测试"], {
      env: { MOCK_PORT: String(MOCK_PORT) },
    });
    expect(code).toBe(0);
    expect(stdout).toContain("运行完成");
    expect(stdout).toContain("耗时");
  });

  it("run 非法 --session id（路径穿越防护）退出码 1", () => {
    const { code, stderr } = runCli(["run", mockConfigPath, "--session", "../../evil"], {
      env: { MOCK_PORT: String(MOCK_PORT) },
    });
    expect(code).toBe(1);
    expect(stderr).toContain("会话 id");
  });

  it("run 不存在的配置文件退出码 1", () => {
    const { code } = runCli(["run", "no-such-file.yaml"]);
    expect(code).toBe(1);
  });

  it("run --resume 对未知 RunState 明确失败", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-resume-e2e-"));
    const configPath = path.join(dir, "coremind.yaml");
    writeFileSync(
      configPath,
      [
        "schemaVersion: 2",
        "name: resume-test",
        "agents:",
        "  main:",
        "    systemPrompt: 测试",
      ].join("\n"),
      "utf8",
    );

    const { code, stderr } = runCli(
      ["run", configPath, "--resume", "missing-run", "--prompt", "原始输入"],
      { cwd: dir },
    );

    expect(code).toBe(1);
    expect(stderr).toContain("没有可恢复的 RunState");
  });

  it("run 非法配置退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const bad = path.join(dir, "bad.yaml");
    require("node:fs").writeFileSync(bad, "schemaVersion: 2\nagents: not-an-object\n", "utf8");
    const { code, stderr } = runCli(["run", bad]);
    expect(code).toBe(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("未知命令退出码 1 且打印帮助", () => {
    const { code, stdout } = runCli(["frobnicate"]);
    expect(code).toBe(1);
    expect(stdout).toContain("用法");
  });

  it("run --session 保存并在二次运行恢复（断点续聊）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const yaml = path.join(dir, "session.yaml");
    writeFileSync(
      yaml,
      [
        "schemaVersion: 2",
        "name: session-test",
        "provider:",
        "  id: mock",
        "  baseUrl: http://127.0.0.1:8799/v1",
        "  model: mock-model",
        "  apiKey: mock-key",
        "agents:",
        "  main:",
        "    systemPrompt: 测试助手",
        "session:",
        "  enabled: true",
        "  dir: ./sessions",
      ].join("\n"),
      "utf8",
    );
    const env = { MOCK_PORT: String(MOCK_PORT) };
    const first = runCli(["run", yaml, "--prompt", "第一轮", "--session", "s1", "--print"], {
      cwd: dir,
      env,
    });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("会话已保存");
    expect(existsSync(path.join(dir, "sessions", "s1.jsonl"))).toBe(true);

    const second = runCli(["run", yaml, "--prompt", "第二轮", "--session", "s1", "--print"], {
      cwd: dir,
      env,
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("已恢复会话 s1");
  });

  it("chat 交互：对话回复 + /exit 命令退出", () => {
    // 注：管道 stdin 下 Node readline 在 EOF 后不可靠，多轮交互由真实使用验证
    const { stdout, code } = runCli(["chat", mockConfigPath, "--quiet"], {
      env: { MOCK_PORT: String(MOCK_PORT) },
      input: "第一轮\n/exit\n",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("mock回复：第一轮");
  });

  it("chat 交互：/help 显示命令", () => {
    const { stdout, code } = runCli(["chat", mockConfigPath, "--quiet"], {
      env: { MOCK_PORT: String(MOCK_PORT) },
      input: "/help\n/exit\n",
    });
    expect(code).toBe(0);
    expect(stdout).toContain("/exit");
  });

  it("run --max-steps 超出上限退出码 1", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-e2e-"));
    const yaml = path.join(dir, "maxsteps.yaml");
    writeFileSync(
      yaml,
      [
        "schemaVersion: 2",
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
