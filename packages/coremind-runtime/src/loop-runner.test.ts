import type { LoopConfig } from "coremind-config";
import { describe, expect, it, vi } from "vitest";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { LoopRunner, type LoopStepRequest } from "./loop-runner.js";
import type { CompletedWorkflowStep } from "./orchestrator.js";

const baseLoop: LoopConfig = {
  execute: { agent: "coder", input: "执行 {{prompt}}" },
  verify: {
    agent: "reviewer",
    input: "检查 {{candidate.text}}，第 {{iteration}} 轮",
    passIf: "{{text}} == PASS",
  },
  repair: { agent: "coder", input: "根据 {{verification.text}} 修复 {{candidate.text}}" },
  maxIterations: 3,
  maxRepairs: 2,
  maxRepeatedAction: 3,
  onFailure: "repair",
  onExhausted: "fail",
};

function createRunner(
  responses: string[],
  options: {
    loop?: LoopConfig;
    restoredSnapshot?: ConstructorParameters<typeof LoopRunner>[0]["restoredSnapshot"];
    completedSteps?: ReadonlyMap<string, CompletedWorkflowStep>;
    verifyEvidence?: ConstructorParameters<typeof LoopRunner>[0]["verifyEvidence"];
  } = {},
) {
  const events: CoreMindEvent[] = [];
  const snapshots: Array<ReturnType<LoopRunner["getSnapshot"]>> = [];
  const requests: LoopStepRequest[] = [];
  const executeStep = vi.fn(async (request: LoopStepRequest) => {
    requests.push(request);
    const response = responses.shift();
    if (response === undefined) throw new Error("缺少模拟响应");
    return response;
  });
  const runner = new LoopRunner({
    runId: "run-loop",
    configFingerprint: "config-v1",
    initialPrompt: "修复缺陷",
    loop: options.loop ?? baseLoop,
    executeStep,
    emit: (event) => events.push(event),
    persistSnapshot: async (snapshot) => {
      snapshots.push(snapshot);
    },
    restoredSnapshot: options.restoredSnapshot,
    completedSteps: options.completedSteps,
    verifyEvidence: options.verifyEvidence,
  });
  return { runner, events, snapshots, requests, executeStep };
}

describe("LoopRunner", () => {
  it("Runtime 证据门可否决模型输出的 PASS", async () => {
    const { runner } = createRunner(["candidate", "PASS"], {
      loop: { ...baseLoop, maxIterations: 1, maxRepairs: 0 },
      verifyEvidence: () => false,
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("failed");
    expect(result.error).toMatchObject({ code: "loop_exhausted" });
  });

  it("执行、验证失败、修复、再次验证通过后才成功", async () => {
    const { runner, events, snapshots, requests } = createRunner([
      "candidate-a",
      "FAIL",
      "candidate-b",
      "PASS",
    ]);

    const result = await runner.run();

    expect(result.error).toBeUndefined();
    expect(result.snapshot.phase).toBe("succeeded");
    expect(result.transcript).toBe("candidate-b");
    expect(result.outputs.get("candidate")?.text).toBe("candidate-b");
    expect(requests.map((request) => request.stepId)).toEqual([
      "loop-execute",
      "loop-verify-1",
      "loop-repair-1",
      "loop-verify-2",
    ]);
    expect(requests[2]?.input).toContain("FAIL");
    expect(events.filter((event) => event.type === "loop_state").map((event) => event.to)).toEqual([
      "executing",
      "verifying",
      "repairing",
      "verifying",
      "succeeded",
    ]);
    expect(snapshots.at(-1)?.phase).toBe("succeeded");
  });

  it("规划输出可供执行阶段插值", async () => {
    const loop: LoopConfig = {
      ...baseLoop,
      planning: { agent: "planner", input: "规划 {{prompt}}" },
      execute: { agent: "coder", input: "按 {{plan.text}} 执行" },
    };
    const { runner, requests } = createRunner(["plan-a", "candidate-a", "PASS"], { loop });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("succeeded");
    expect(requests.map((request) => request.stepId)).toEqual([
      "loop-plan",
      "loop-execute",
      "loop-verify-1",
    ]);
    expect(requests[1]?.input).toBe("按 plan-a 执行");
  });

  it("onFailure=pause 会落稳定快照，恢复后跳过已完成步骤并从修复继续", async () => {
    const loop: LoopConfig = { ...baseLoop, onFailure: "pause" };
    const first = createRunner(["candidate-a", "FAIL"], { loop });
    const paused = await first.runner.run();

    expect(paused.snapshot).toMatchObject({
      phase: "paused",
      pauseReason: "verification_failed",
      resumePhase: "repairing",
    });
    expect(paused.error).toMatchObject({ code: "loop_paused" });

    const completed = new Map<string, CompletedWorkflowStep>([
      [
        "loop-execute",
        {
          output: {
            text: "candidate-a",
            metadata: { agent: "coder", stepId: "loop-execute" },
          },
        },
      ],
      [
        "loop-verify-1",
        {
          saveAs: "verification",
          output: {
            text: "FAIL",
            metadata: { agent: "reviewer", stepId: "loop-verify-1" },
          },
        },
      ],
    ]);
    const resumed = createRunner(["candidate-b", "PASS"], {
      loop,
      restoredSnapshot: paused.snapshot,
      completedSteps: completed,
    });

    const result = await resumed.runner.run();

    expect(result.snapshot.phase).toBe("succeeded");
    expect(resumed.requests.map((request) => request.stepId)).toEqual([
      "loop-repair-1",
      "loop-verify-2",
    ]);
    expect(resumed.events.some((event) => event.type === "step_resumed")).toBe(false);
  });

  it("达到最大修复次数后以失败结束且不再执行动作", async () => {
    const loop: LoopConfig = { ...baseLoop, maxRepairs: 0 };
    const { runner, executeStep } = createRunner(["candidate-a", "FAIL"], { loop });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("failed");
    expect(result.error).toMatchObject({ code: "loop_exhausted" });
    expect(executeStep).toHaveBeenCalledTimes(2);
  });

  it("执行器失败时保存失败状态并保留原错误", async () => {
    const original = Object.assign(new Error("provider down"), { status: 503 });
    const runner = new LoopRunner({
      runId: "run-loop",
      configFingerprint: "config-v1",
      initialPrompt: "修复缺陷",
      loop: baseLoop,
      executeStep: async () => {
        throw original;
      },
      emit: () => {},
      persistSnapshot: async () => {},
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("failed");
    expect(result.error).toBe(original);
  });

  it("终态后的中止不覆盖既有终态或重复持久化", async () => {
    const { runner, snapshots } = createRunner(["candidate", "PASS"]);
    const result = await runner.run();
    const persistedCount = snapshots.length;

    await runner.interrupt(new CoreMindError("run_timeout", "迟到的中止"));

    expect(result.snapshot.phase).toBe("succeeded");
    expect(runner.getSnapshot().phase).toBe("succeeded");
    expect(snapshots).toHaveLength(persistedCount);
  });

  it("缺省有界参数生效，未知插值变量保持原样", async () => {
    const loop: LoopConfig = {
      execute: { agent: "coder", input: "执行 {{missing}}" },
      verify: { agent: "reviewer", input: "检查", passIf: "{{text}} == PASS" },
      repair: { agent: "coder", input: "修复" },
    };
    const requests: LoopStepRequest[] = [];
    const runner = new LoopRunner({
      runId: "run-defaults",
      configFingerprint: "config-defaults",
      loop,
      executeStep: async (request) => {
        requests.push(request);
        return request.kind === "verify" ? "PASS" : "candidate";
      },
      emit: () => {},
      persistSnapshot: async () => {},
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("succeeded");
    expect(requests[0]?.input).toBe("执行 {{missing}}");
  });

  it("步骤输出已落盘但状态快照未推进时复用稳定步骤", async () => {
    const controller = createRunner(["unused"]).runner.getSnapshot();
    const executingSnapshot = { ...controller, phase: "executing" as const, transitionSequence: 1 };
    const completed = new Map<string, CompletedWorkflowStep>([
      [
        "loop-execute",
        {
          saveAs: "candidate",
          output: {
            text: "candidate-a",
            metadata: { agent: "coder", stepId: "loop-execute" },
          },
        },
      ],
    ]);
    const resumed = createRunner(["PASS"], {
      restoredSnapshot: executingSnapshot,
      completedSteps: completed,
    });

    const result = await resumed.runner.run();

    expect(result.snapshot.phase).toBe("succeeded");
    expect(resumed.requests.map((request) => request.stepId)).toEqual(["loop-verify-1"]);
    expect(resumed.events.some((event) => event.type === "step_resumed")).toBe(true);
  });

  it("恢复已完成步骤但记录缺少 saveAs 时仍复用输出", async () => {
    const controller = createRunner(["unused"]).runner.getSnapshot();
    const executingSnapshot = {
      ...controller,
      phase: "executing" as const,
      transitionSequence: 1,
    };
    const completed = new Map<string, CompletedWorkflowStep>([
      [
        "loop-execute",
        {
          output: {
            text: "candidate-a",
            metadata: { agent: "coder", stepId: "loop-execute" },
          },
        },
      ],
    ]);
    const resumed = createRunner(["PASS"], {
      restoredSnapshot: executingSnapshot,
      completedSteps: completed,
    });

    const result = await resumed.runner.run();

    expect(result.snapshot.phase).toBe("succeeded");
    expect(result.transcript).toBe("candidate-a");
    expect(resumed.events.some((event) => event.type === "step_resumed")).toBe(true);
  });

  it.each([
    [new CoreMindError("approval_denied", "等待审批"), "paused", "loop_paused"],
    [new CoreMindError("aborted", "用户中止"), "aborted", "aborted"],
    [new CoreMindError("step_timeout", "步骤超时"), "timeout", "step_timeout"],
    [new CoreMindError("budget_exceeded", "预算耗尽"), "budget_exceeded", "budget_exceeded"],
  ] as const)("把执行错误 %o 映射到控制器状态 %s", async (error, phase, returnedCode) => {
    const runner = new LoopRunner({
      runId: "run-error",
      configFingerprint: "config-error",
      initialPrompt: "执行",
      loop: baseLoop,
      executeStep: async () => {
        throw error;
      },
      emit: () => {},
      persistSnapshot: async () => {},
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe(phase);
    expect(result.error).toMatchObject({ code: returnedCode });
  });

  it("执行器抛出非 Error 对象时按普通失败处理", async () => {
    const runner = new LoopRunner({
      runId: "run-string-error",
      configFingerprint: "config-string-error",
      initialPrompt: "执行",
      loop: baseLoop,
      executeStep: async () => {
        throw "plain failure";
      },
      emit: () => {},
      persistSnapshot: async () => {},
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("failed");
    expect(result.error).toBe("plain failure");
  });

  it("没有继续目标的耗尽暂停不会伪造恢复迁移", async () => {
    const paused = {
      ...createRunner(["unused"]).runner.getSnapshot(),
      phase: "paused" as const,
      pauseReason: "loop_exhausted",
      failureCode: "loop_exhausted",
      failureMessage: "Loop 已耗尽",
      transitionSequence: 3,
    };
    const persistSnapshot = vi.fn(async () => {});
    const runner = new LoopRunner({
      runId: "run-loop",
      configFingerprint: "config-v1",
      initialPrompt: "修复缺陷",
      loop: baseLoop,
      restoredSnapshot: paused,
      executeStep: async () => "unused",
      emit: () => {},
      persistSnapshot,
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("paused");
    expect(result.error).toMatchObject({ code: "loop_paused" });
    expect(persistSnapshot).not.toHaveBeenCalled();
  });

  it("恢复到与配置不一致的规划阶段时明确失败", async () => {
    const snapshot = {
      ...createRunner(["unused"]).runner.getSnapshot(),
      phase: "planning" as const,
      transitionSequence: 1,
    };
    const runner = new LoopRunner({
      runId: "run-loop",
      configFingerprint: "config-v1",
      loop: baseLoop,
      restoredSnapshot: snapshot,
      executeStep: async () => "unused",
      emit: () => {},
      persistSnapshot: async () => {},
    });

    const result = await runner.run();

    expect(result.snapshot.phase).toBe("failed");
    expect(result.error).toMatchObject({ code: "loop_config_invalid" });
  });
});
