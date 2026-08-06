import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  findUnknownKeys,
  parseAndValidate,
  validateConfig,
} from "./validate.js";

const validYaml = {
  version: 1,
  name: "demo",
  provider: { id: "deepseek" },
  agents: {
    main: { systemPrompt: "你好", tools: [{ id: "bash" }] },
  },
};

describe("validateConfig", () => {
  it("合法配置通过校验并填充默认值", () => {
    const config = validateConfig(validYaml);
    expect(config.name).toBe("demo");
    // 默认值：全局 tools 为空数组、systemPrompt 有默认
    expect(config.tools).toEqual([]);
    expect(config.agents.main?.systemPrompt).toBe("你好");
    // 注意：Union 成员内部默认值（如 enabled）由运行时层兜底，TypeBox 不填充
    expect(config.agents.main?.tools).toEqual([{ id: "bash" }]);
  });

  it("缺少必填 name 时报中文可读错误", () => {
    expect(() => validateConfig({ version: 1, agents: {} })).toThrow(ConfigValidationError);
    try {
      validateConfig({ version: 1, agents: {} });
    } catch (e) {
      const err = e as ConfigValidationError;
      expect(err.message).toContain("配置校验失败");
      expect(err.details.join("\n")).toContain("name");
    }
  });

  it("agents 内非法字段给出带路径的错误", () => {
    try {
      validateConfig({
        version: 1,
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
      version: 1,
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

  it("自定义 provider（OpenAI 兼容端点）通过校验", () => {
    const config = validateConfig({
      version: 1,
      name: "local",
      provider: { id: "ollama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
      agents: { main: {} },
    });
    expect(config.provider).toMatchObject({ baseUrl: "http://localhost:11434/v1" });
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
