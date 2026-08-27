import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  it("Evaluation Runtime 的未知 Adapter 错误归一化为人工暂停", async () => {
    const runtimeFactory: EvaluationRuntimeFactory = async () => ({
      run: async () => {
        throw Object.assign(new Error("Bearer evaluation-secret"), {
          code: "vendor_evaluation?token=evaluation-secret",
        });
      },
    });

    const result = await runEvaluationSuite({
      config: { ...config, quality: { profile: "development" } },
      configDir: ".",
      runtimeFactory,
      suite: {
        schemaVersion: 1,
        scenarios: [{ id: "unknown-adapter", input: "执行", expected: {} }],
      },
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.outcome).toMatchObject({
      status: "paused",
      finishReason: "unclassified_error",
      error: {
        code: "unclassified_error",
        audit: { originalCode: "vendor_evaluation?token=hidden" },
      },
    });
    expect(JSON.stringify(result.attempts[0]?.outcome)).not.toContain("evaluation-secret");
  });

  it("schemaVersion 2 的七类 grader 共同验证代码修复结果", async () => {
    const cwd = createEvaluationRepository();
    const runtimeFactory: EvaluationRuntimeFactory = async () => ({
      run: async () => {
        writeFileSync(path.join(cwd, "src", "value.js"), "export const value = 2;\n", "utf8");
        return successfulResult("修复完成", {
          trace: toolTrace([
            ["bash", { command: "node --test test.mjs" }],
            ["read", { path: "src/value.js" }],
            ["edit", { path: "src/value.js" }],
            ["bash", { command: "node --test test.mjs" }],
            ["bash", { command: "node --test" }],
          ]),
          checkpoints: [{ checkpointId: "checkpoint-1" }],
          metrics: {
            durationMs: 20,
            turns: 5,
            steps: { total: 0, succeeded: 0, failed: 0 },
            toolCalls: 5,
            toolFailures: 0,
            retries: 0,
            outputChars: 4,
          },
        });
      },
    });

    const result = await runEvaluationSuite({
      config: { ...config, quality: { profile: "development", minScenarioPassRate: 1 } },
      configDir: cwd,
      cwd,
      runtimeFactory,
      suite: {
        schemaVersion: 2,
        scenarios: [
          {
            id: "code-fix",
            input: "修复 value",
            graders: [
              { type: "outcome", status: "succeeded" },
              {
                type: "trajectory",
                sequence: [
                  { tool: "bash", argsContains: "test.mjs" },
                  { tool: "read" },
                  { tool: "edit" },
                  { tool: "bash", argsContains: "test.mjs" },
                  { tool: "bash", argsContains: "node --test" },
                ],
                maxToolFailures: 0,
              },
              { type: "command", command: process.execPath, args: ["--test", "test.mjs"] },
              { type: "file", path: "src/value.js", contains: ["value = 2"] },
              {
                type: "diff",
                allowedPaths: ["src/value.js"],
                requiredPaths: ["src/value.js"],
                forbiddenPaths: [".env"],
                maxChangedFiles: 1,
                contains: ["+export const value = 2;"],
                preserveExisting: true,
              },
              {
                type: "state",
                finishReason: "completed",
                minCheckpoints: 1,
                maxToolFailures: 0,
                maxApprovals: 0,
                maxSecurityFindings: 0,
              },
              { type: "response", contains: ["修复完成"] },
            ],
          },
        ],
      },
    });

    expect(result.passRate).toBe(1);
    expect(result.attempts[0]?.graderResults).toHaveLength(7);
    expect(result.attempts[0]?.metrics?.toolCalls).toBe(5);
    expect(result.attempts[0]?.approvalCount).toBe(0);
  });

  it("diff grader 识别并阻止覆盖既有脏工作区内容", async () => {
    const cwd = createEvaluationRepository();
    const runtimeFactory: EvaluationRuntimeFactory = async () => ({
      run: async () => {
        writeFileSync(path.join(cwd, "notes.txt"), "Agent 覆盖内容\n", "utf8");
        return successfulResult("完成");
      },
    });
    const result = await runEvaluationSuite({
      config: { ...config, quality: { profile: "development", minScenarioPassRate: 1 } },
      configDir: cwd,
      cwd,
      runtimeFactory,
      suite: {
        schemaVersion: 2,
        scenarios: [
          {
            id: "dirty-protection",
            input: "不要覆盖用户内容",
            graders: [
              { type: "outcome", status: "succeeded" },
              { type: "diff", allowedPaths: ["src/value.js"], preserveExisting: true },
            ],
          },
        ],
      },
    });

    expect(result.passRate).toBe(0);
    expect(result.attempts[0]?.reason).toContain("既有脏工作区内容被修改");
  });

  it("schemaVersion 2 强制包含 outcome grader 并校验 grader 字段", () => {
    expect(() =>
      validateEvaluationSuite({
        schemaVersion: 2,
        scenarios: [
          { id: "invalid-v2", input: "执行", graders: [{ type: "command", command: "" }] },
        ],
      }),
    ).toThrow(/command 不能为空|outcome grader/);
  });
});

function successfulResult(transcript: string, overrides: Record<string, unknown> = {}): any {
  const base = {
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
  return { ...base, ...overrides };
}

function createEvaluationRepository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-evaluation-v2-"));
  mkdirSync(path.join(cwd, "src"));
  writeFileSync(path.join(cwd, "src", "value.js"), "export const value = 1;\n", "utf8");
  writeFileSync(
    path.join(cwd, "test.mjs"),
    'import assert from "node:assert/strict";\nimport { value } from "./src/value.js";\nassert.equal(value, 2);\n',
    "utf8",
  );
  writeFileSync(path.join(cwd, "notes.txt"), "基线\n", "utf8");
  git(cwd, "init");
  git(cwd, "config", "user.email", "coremind@example.invalid");
  git(cwd, "config", "user.name", "CoreMind Test");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  writeFileSync(path.join(cwd, "notes.txt"), "用户尚未提交的草稿\n", "utf8");
  return cwd;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function toolTrace(calls: Array<[string, unknown]>): any[] {
  return calls.map(([tool, args], index) => ({
    eventId: `event-${index}`,
    runId: "run-test",
    sequence: index + 1,
    timestamp: "2026-08-09T00:00:00.000Z",
    event: { type: "tool_call", agent: "main", tool, args, callId: `call-${index}` },
  }));
}
