// 真实 LLM 集成测试（opt-in）：需设置 REAL_LLM_TEST=1 与 DEEPSEEK_API_KEY
// 运行：REAL_LLM_TEST=1 DEEPSEEK_API_KEY=xxx npx vitest run src/integration.real.test.ts

import { parseAndValidate } from "coremind-config";
import { describe, expect, it } from "vitest";
import { CoreMindRuntime } from "./runtime.js";

const enabled = process.env.REAL_LLM_TEST === "1" && Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!enabled)("真实 LLM 集成测试（REAL_LLM_TEST）", () => {
  it("单 agent 直答返回非空文本", async () => {
    const { config } = parseAndValidate({
      version: 1,
      name: "integration-single",
      provider: { id: "deepseek", model: "deepseek-v4-flash" },
      agents: { assistant: { systemPrompt: "你是简洁的助手，回答不超过 30 个字。" } },
    });
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: process.cwd(),
      initialPrompt: "用一句话介绍你自己",
    });
    const result = await runtime.run();
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.messages.get("assistant")?.length).toBeGreaterThan(0);
  }, 120_000);

  it("双 agent workflow 变量传递", async () => {
    const { config } = parseAndValidate({
      version: 1,
      name: "integration-workflow",
      provider: { id: "deepseek", model: "deepseek-v4-flash" },
      agents: {
        a: { systemPrompt: "只输出一行事实，不要多余内容。" },
        b: { systemPrompt: "根据输入输出一句话总结。" },
      },
      workflow: [
        {
          id: "s1",
          type: "call",
          agent: "a",
          input: "今天天气如何？请回答：今天天气晴朗",
          saveAs: "fact",
        },
        { id: "s2", type: "call", agent: "b", input: "总结这句话：{{fact.text}}", saveAs: "sum" },
      ],
    });
    const runtime = await CoreMindRuntime.create({ config, configDir: process.cwd() });
    const result = await runtime.run();
    expect(result.transcript.length).toBeGreaterThan(0);
    expect(result.outputs.get("fact")?.text.length).toBeGreaterThan(0);
    expect(result.outputs.get("sum")?.text.length).toBeGreaterThan(0);
  }, 180_000);
});
