import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import {
  type EvaluationRuntimeFactory,
  runEvaluationSuite,
  validateEvaluationSuite,
} from "./evaluation.js";

const config: CoreMindConfig = {
  schemaVersion: 2,
  name: "eval",
  agents: { main: { systemPrompt: "测试" } },
  quality: { profile: "strict", minScenarioPassRate: 1, allowOverride: true },
};

describe("runEvaluationSuite", () => {
  it.each([
    ["非法 outcome", { outcome: "maybe" }, 1],
    ["非字符串 contains", { contains: [1] }, 1],
    ["零次重复", {}, 0],
    ["非整数重复", {}, 1.5],
    ["过多重复", {}, 101],
  ])("拒绝%s", (_label, expected, repetitions) => {
    expect(() =>
      validateEvaluationSuite({
        schemaVersion: 1,
        scenarios: [{ id: "invalid", input: "执行", expected, repetitions }],
      }),
    ).toThrow();
  });

  it("strict 档每个场景至少运行三次并计算通过率", async () => {
    let calls = 0;
    const runtimeFactory: EvaluationRuntimeFactory = async () => ({
      run: async () => {
        calls += 1;
        return successfulResult("订单已支付");
      },
    });

    const result = await runEvaluationSuite({
      config,
      configDir: ".",
      runtimeFactory,
      suite: {
        schemaVersion: 1,
        scenarios: [{ id: "paid-order", input: "查询订单", expected: { contains: ["已支付"] } }],
      },
    });

    expect(calls).toBe(3);
    expect(result.report.scenarioResults[0]).toMatchObject({ passed: true, score: 1 });
    expect(result.passRate).toBe(1);
    expect(result.releaseReadiness.ready).toBe(true);
  });

  it("失败运行不会被计为场景通过", async () => {
    const runtimeFactory: EvaluationRuntimeFactory = async () => ({
      run: async () => {
        throw Object.assign(new Error("模型失败"), { code: "agent_failed" });
      },
    });

    const result = await runEvaluationSuite({
      config: { ...config, quality: { profile: "development" } },
      configDir: ".",
      runtimeFactory,
      suite: {
        schemaVersion: 1,
        scenarios: [{ id: "failure", input: "执行", expected: { contains: ["完成"] } }],
      },
    });

    expect(result.passRate).toBe(0);
    expect(result.report.scenarioResults[0]?.passed).toBe(false);
    expect(result.releaseReadiness.ready).toBe(false);
  });
});

function successfulResult(transcript: string): any {
  return {
    runId: "run-test",
    outcome: { status: "succeeded", finishReason: "completed" },
    metrics: {
      durationMs: 1,
      turns: 1,
      steps: { total: 0, succeeded: 0, failed: 0 },
      toolCalls: 0,
      toolFailures: 0,
      retries: 0,
      outputChars: transcript.length,
    },
    evaluation: {
      profile: "strict",
      scenarioResults: [],
      qualityScores: {},
      securityFindings: [],
    },
    releaseReadiness: { ready: false, blockers: [], warnings: [] },
    trace: [],
    outputs: new Map(),
    messages: new Map(),
    transcript,
    checkpoints: [],
  };
}
