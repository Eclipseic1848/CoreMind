import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  findUnknownKeys,
  parseAndValidate,
  validateConfig,
} from "./validate.js";

const validYaml = {
  schemaVersion: 2 as const,
  name: "demo",
  provider: { id: "deepseek" },
  agents: {
    main: { systemPrompt: "你好", tools: [{ id: "bash" }] },
  },
};

describe("validateConfig", () => {
  it("Delegation 默认关闭，显式命名 Target 时保留固定预算", () => {
    const disabled = validateConfig(validYaml);
    expect(disabled.agents.main).not.toHaveProperty("delegation");

    const enabled = validateConfig({
      ...validYaml,
      agents: {
        main: {
          delegation: {
            targets: {
              researcher: {
                budget: {
                  tokens: 500,
                  toolCalls: 2,
                  costUsd: 0.5,
                  wallTimeMs: 5_000,
                  steps: 2,
                  descendants: 0,
                },
              },
            },
          },
        },
        researcher: { systemPrompt: "执行子任务" },
      },
    });

    expect(enabled.agents.main).toMatchObject({
      delegation: {
        targets: {
          researcher: {
            budget: {
              tokens: 500,
              toolCalls: 2,
              costUsd: 0.5,
              wallTimeMs: 5_000,
              steps: 2,
              descendants: 0,
            },
          },
        },
      },
    });
  });

  it.each([
    ["未定义", "missing"],
    ["自身", "main"],
  ])("拒绝委派给%s Delegation Target", (_caseName, target) => {
    expect(() =>
      validateConfig({
        ...validYaml,
        agents: {
          main: {
            delegation: {
              targets: {
                [target]: {
                  budget: {
                    tokens: 100,
                    toolCalls: 1,
                    costUsd: 0.1,
                    wallTimeMs: 1_000,
                    steps: 1,
                    descendants: 0,
                  },
                },
              },
            },
          },
        },
      }),
    ).toThrow(`agents.main.delegation.targets.${target}`);
  });

  it("接受后端无关的 SecretRef 与 Header 引用", () => {
    const { config } = parseAndValidate({
      schemaVersion: 2,
      name: "secret-ref-contract",
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "probe",
        apiKeySecretRef: { secretRef: "vault-neutral/key" },
        headers: {
          Authorization: { secretRef: "vault-neutral/header" },
          "X-Tenant": { env: "TENANT_ID" },
        },
      },
      agents: { main: {} },
    });

    expect(config.provider).toMatchObject({
      apiKeySecretRef: { secretRef: "vault-neutral/key" },
      headers: {
        Authorization: { secretRef: "vault-neutral/header" },
        "X-Tenant": { env: "TENANT_ID" },
      },
    });
  });

  it.each([
    { apiKeyEnv: "" },
    { apiKeySecretRef: { secretRef: "" } },
    { headers: { Authorization: { env: "" } } },
    { headers: { Authorization: { secretRef: "" } } },
  ])("拒绝空凭据引用 %#", (credentialConfig) => {
    expect(() =>
      parseAndValidate({
        schemaVersion: 2,
        name: "empty-secret-reference",
        provider: {
          id: "gateway",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "probe",
          ...credentialConfig,
        },
        agents: { main: {} },
      }),
    ).toThrow();
  });
  it("旧版 version 配置给出明确的 v2 迁移提示", () => {
    const { schemaVersion: _schemaVersion, ...oldConfig } = validYaml;
    expect(() => validateConfig({ ...oldConfig, version: 1 })).toThrow("schemaVersion: 2");
  });

  it("合法配置通过校验并填充默认值", () => {
    const config = validateConfig(validYaml);
    expect(config.name).toBe("demo");
    // 默认值：全局 tools 为空数组、systemPrompt 有默认
    expect(config.tools).toEqual([]);
    expect(config.agents.main?.systemPrompt).toBe("你好");
    // 注意：Union 成员内部默认值（如 enabled）由运行时层兜底，TypeBox 不填充
    expect(config.agents.main?.tools).toEqual([{ id: "bash" }]);
  });

  it("v2 Harness、权限和质量配置填充安全默认值", () => {
    const config = validateConfig({
      ...validYaml,
      runtime: {},
      permissions: {},
      quality: {},
    });

    expect(config.runtime).toMatchObject({
      maxTurns: 20,
      maxSteps: 100,
      stepTimeoutMs: 300_000,
      runTimeoutMs: 900_000,
      maxToolCalls: 50,
      maxToolFailures: 3,
      maxRetries: 3,
    });
    expect(config.permissions).toMatchObject({
      mode: "ask",
      workspaceOnly: true,
      network: "ask",
    });
    expect(config.quality).toMatchObject({ profile: "standard", allowOverride: true });
  });

  it("Telemetry 配置填充无外传安全默认值", () => {
    const config = validateConfig({ ...validYaml, telemetry: {} });

    expect(config.telemetry).toEqual({
      mode: "DISABLED",
      contentLevel: "metrics_only",
      allowedFields: [],
    });
  });

  it("启用 Telemetry 必须提供 HTTP(S) endpoint，未知模式失败关闭", () => {
    expect(() => validateConfig({ ...validYaml, telemetry: { mode: "FULL" } })).toThrow(
      "telemetry.endpoint",
    );
    expect(() =>
      validateConfig({
        ...validYaml,
        telemetry: { mode: "FEEDBACK_ONLY", endpoint: "file:///tmp/telemetry" },
      }),
    ).toThrow("telemetry.endpoint");
    expect(() => validateConfig({ ...validYaml, telemetry: { mode: "UNKNOWN" } })).toThrow(
      ConfigValidationError,
    );

    const config = validateConfig({
      ...validYaml,
      telemetry: {
        mode: "FULL",
        endpoint: "https://telemetry.example/v1/traces?token=secret",
        contentLevel: "metrics_only",
      },
    });
    expect(config.telemetry).toMatchObject({
      mode: "FULL",
      endpoint: "https://telemetry.example/v1/traces?token=secret",
      contentLevel: "metrics_only",
      allowedFields: [],
    });
  });

  it("缺少必填 name 时报中文可读错误", () => {
    expect(() => validateConfig({ schemaVersion: 2, agents: {} })).toThrow(ConfigValidationError);
    try {
      validateConfig({ schemaVersion: 2, agents: {} });
    } catch (e) {
      const err = e as ConfigValidationError;
      expect(err.code).toBe("invalid_config");
      expect(err.message).toContain("配置校验失败");
      expect(err.details.join("\n")).toContain("name");
    }
  });

  it("agents 内非法字段给出带路径的错误", () => {
    try {
      validateConfig({
        schemaVersion: 2,
        name: "demo",
        agents: { main: { systemPrompt: 123 } },
      });
      throw new Error("应当抛错");
    } catch (e) {
      const err = e as ConfigValidationError;
      expect(err.details.join("\n")).toContain("agents.main.systemPrompt");
    }
  });

  it("workflow 递归嵌套（if 内含 parallel）通过校验", () => {
    const config = validateConfig({
      schemaVersion: 2,
      name: "wf",
      agents: { a: { systemPrompt: "x" }, b: { systemPrompt: "y" } },
      workflow: [
        {
          id: "s1",
          type: "prompt",
          agent: "a",
          input: "hello",
          saveAs: "r",
        },
        {
          id: "s2",
          type: "if",
          condition: "{{r.text}} contains 无",
          then: [
            {
              id: "p1",
              type: "parallel",
              steps: [{ id: "p2", type: "call", agent: "b", input: "x" }],
            },
          ],
          else: [{ id: "s3", type: "switch", on: "r.text", cases: { 完成: [] } }],
        },
      ],
    });
    expect(config.workflow).toHaveLength(2);
  });

  it("拒绝重复的 workflow 步骤 id，保证恢复边界唯一", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        name: "duplicate-workflow-id",
        agents: { main: { systemPrompt: "x" } },
        workflow: [
          { id: "same", type: "prompt", agent: "main", input: "a" },
          {
            id: "branch",
            type: "if",
            condition: "true",
            then: [{ id: "same", type: "call", agent: "main", input: "b" }],
          },
        ],
      }),
    ).toThrow("workflow 步骤 id 重复：same");
  });

  it("显式 Loop 配置填充有界默认值", () => {
    const config = validateConfig({
      schemaVersion: 2,
      name: "verified-loop",
      agents: {
        worker: { systemPrompt: "执行任务" },
        reviewer: { systemPrompt: "验证结果" },
      },
      loop: {
        execute: { agent: "worker", input: "{{prompt}}" },
        verify: {
          agent: "reviewer",
          input: "检查 {{candidate.text}}",
          passIf: "{{text}} contains PASS",
        },
        repair: { agent: "worker", input: "根据 {{verification.text}} 修复" },
      },
    });

    expect(config.loop).toMatchObject({
      maxIterations: 3,
      maxRepairs: 2,
      maxRepeatedAction: 2,
      onFailure: "repair",
      onExhausted: "fail",
    });
  });

  it("workflow 与 loop 不能同时配置，避免两个控制器争夺运行权", () => {
    expect(() =>
      validateConfig({
        ...validYaml,
        workflow: [{ id: "s1", type: "prompt", agent: "main", input: "x" }],
        loop: {
          execute: { agent: "main", input: "x" },
          verify: { agent: "main", input: "检查", passIf: "{{text}} contains PASS" },
          repair: { agent: "main", input: "修复" },
        },
      }),
    ).toThrow("workflow 与 loop 只能选择一种");
  });

  it("Runtime 证据门会填充安全默认值", () => {
    const config = validateConfig({
      ...validYaml,
      loop: {
        execute: { agent: "main", input: "执行" },
        verify: {
          agent: "main",
          input: "验证",
          passIf: "{{text}} == PASS",
          evidence: { mode: "runtime", regressionCommand: "npm test" },
        },
        repair: { agent: "main", input: "修复" },
      },
    });

    expect(config.loop?.verify.evidence).toEqual({
      mode: "runtime",
      regressionCommand: "npm test",
      minSuccessfulTestCommands: 2,
      requireCheckpoint: true,
      requireDiffReview: true,
    });
  });

  it("Loop 的每个阶段都必须引用已定义 Agent", () => {
    expect(() =>
      validateConfig({
        ...validYaml,
        loop: {
          planning: { agent: "missing-planner", input: "规划" },
          execute: { agent: "main", input: "执行" },
          verify: { agent: "missing-reviewer", input: "检查", passIf: "true" },
          repair: { agent: "main", input: "修复" },
        },
      }),
    ).toThrow("loop.planning.agent 引用了未定义的 Agent：missing-planner");
  });

  it("自定义 provider（OpenAI 兼容端点）通过校验", () => {
    const config = validateConfig({
      schemaVersion: 2,
      name: "local",
      provider: { id: "ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
      agents: { main: {} },
    });
    expect(config.provider).toMatchObject({ baseUrl: "http://localhost:11434/v1" });
  });

  it("自定义脚本工具必须声明副作用", () => {
    expect(() =>
      validateConfig({
        ...validYaml,
        tools: [{ path: "./tool.mjs" }],
      }),
    ).toThrow("tools.0.effect");

    const config = validateConfig({
      ...validYaml,
      tools: [
        {
          path: "./tool.mjs",
          effect: { operations: ["write"], reversible: true },
        },
      ],
    });
    expect(config.tools[0]).toMatchObject({
      effect: { operations: ["write"], reversible: true },
    });
  });
});

describe("findUnknownKeys", () => {
  it("顶层与 agents 内未知字段被识别为告警", () => {
    const warnings = findUnknownKeys({
      ...validYaml,
      unknownTop: 1,
      agents: { main: { systemPrompt: "x", unknownAgentField: true } },
    });
    expect(warnings).toContain("顶层存在未知字段：unknownTop（已忽略）");
    expect(warnings).toContain("agents.main 存在未知字段：unknownAgentField（已忽略）");
  });
});

describe("parseAndValidate", () => {
  it("返回配置与告警", () => {
    const { config, warnings } = parseAndValidate({ ...validYaml, extra: 1 });
    expect(config.name).toBe("demo");
    expect(warnings).toHaveLength(1);
  });
});
