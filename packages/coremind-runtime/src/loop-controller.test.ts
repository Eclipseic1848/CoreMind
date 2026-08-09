import { describe, expect, it, vi } from "vitest";
import { CoreMindError } from "./errors.js";
import { LoopController, type LoopControllerSnapshot } from "./loop-controller.js";

function createController(
  overrides: Partial<ConstructorParameters<typeof LoopController>[0]> = {},
): LoopController {
  return new LoopController({
    runId: "run-loop",
    configFingerprint: "config-v1",
    hasPlanning: false,
    maxIterations: 3,
    maxRepairs: 2,
    maxRepeatedAction: 2,
    onFailure: "repair",
    onExhausted: "fail",
    ...overrides,
  });
}

describe("LoopController", () => {
  it("验证失败后必须修复并再次验证，只有验证通过才成功", () => {
    const controller = createController();

    controller.send({ type: "START" });
    expect(controller.phase).toBe("executing");
    controller.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    expect(controller.phase).toBe("verifying");
    controller.send({ type: "VERIFIED", passed: false });
    expect(controller.phase).toBe("repairing");
    controller.send({ type: "REPAIRED", fingerprint: "candidate-b" });
    expect(controller.phase).toBe("verifying");
    controller.send({ type: "VERIFIED", passed: true });

    expect(controller.phase).toBe("succeeded");
    expect(controller.getSnapshot()).toMatchObject({ iteration: 2, repairCount: 1 });
  });

  it("可选规划阶段完成后才进入执行", () => {
    const controller = createController({ hasPlanning: true });

    controller.send({ type: "START" });
    expect(controller.phase).toBe("planning");
    controller.send({ type: "PLANNED" });

    expect(controller.phase).toBe("executing");
  });

  it("最大修复耗尽不能返回成功", () => {
    const controller = createController({ maxRepairs: 0 });

    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    controller.send({ type: "VERIFIED", passed: false });

    expect(controller.phase).toBe("failed");
    expect(controller.getSnapshot().failureCode).toBe("loop_exhausted");
  });

  it("onFailure=fail 在首次验证失败时立即失败", () => {
    const controller = createController({ onFailure: "fail" });
    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    controller.send({ type: "VERIFIED", passed: false });

    expect(controller.getSnapshot()).toMatchObject({
      phase: "failed",
      failureCode: "verification_failed",
    });
  });

  it("达到最大验证轮数时按耗尽策略结束", () => {
    const controller = createController({ maxIterations: 1, onExhausted: "pause" });
    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    controller.send({ type: "VERIFIED", passed: false });

    expect(controller.getSnapshot()).toMatchObject({
      phase: "paused",
      pauseReason: "loop_exhausted",
    });
    controller.send({ type: "RESUME" });
    expect(controller.phase).toBe("paused");
  });

  it("相同动作达到阈值时按耗尽策略暂停", () => {
    const controller = createController({ onExhausted: "pause" });

    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "same" });
    controller.send({ type: "VERIFIED", passed: false });
    controller.send({ type: "REPAIRED", fingerprint: "same" });

    expect(controller.phase).toBe("paused");
    expect(controller.getSnapshot()).toMatchObject({
      repeatedActionCount: 2,
      pauseReason: "loop_no_progress",
    });
  });

  it("相同动作达到阈值时可按耗尽策略失败", () => {
    const controller = createController({ onExhausted: "fail" });

    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "same" });
    controller.send({ type: "VERIFIED", passed: false });
    controller.send({ type: "REPAIRED", fingerprint: "same" });

    expect(controller.phase).toBe("failed");
    expect(controller.getSnapshot().failureCode).toBe("loop_no_progress");
  });

  it("首次动作即达到配置阈值时仍遵守失败策略", () => {
    const controller = createController({ maxRepeatedAction: 1, onExhausted: "fail" });

    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "same" });

    expect(controller.phase).toBe("failed");
    expect(controller.getSnapshot().failureCode).toBe("loop_no_progress");
  });

  it("暂停快照可序列化，并能在新进程语义下显式继续", () => {
    const controller = createController();
    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    controller.send({ type: "PAUSE", reason: "manual_review" });
    const persisted = JSON.parse(
      JSON.stringify(controller.getSnapshot()),
    ) as LoopControllerSnapshot;

    const restored = LoopController.restore(createController().config, persisted);
    expect(restored.phase).toBe("paused");
    restored.send({ type: "RESUME" });

    expect(restored.phase).toBe("verifying");
  });

  it("规划、执行和修复阶段都能在显式暂停后回到原稳定阶段", () => {
    const planning = createController({ hasPlanning: true });
    planning.send({ type: "START" });
    planning.send({ type: "PAUSE", reason: "review-plan" });
    planning.send({ type: "RESUME" });
    expect(planning.phase).toBe("planning");

    const executing = createController();
    executing.send({ type: "START" });
    executing.send({ type: "PAUSE", reason: "review-execution" });
    executing.send({ type: "RESUME" });
    expect(executing.phase).toBe("executing");

    const repairing = createController();
    repairing.send({ type: "START" });
    repairing.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    repairing.send({ type: "VERIFIED", passed: false });
    repairing.send({ type: "PAUSE", reason: "review-repair" });
    repairing.send({ type: "RESUME" });
    expect(repairing.phase).toBe("repairing");
  });

  it("拒绝版本、配置指纹或运行标识不匹配的快照", () => {
    const snapshot = createController().getSnapshot();

    expect(() =>
      LoopController.restore(createController().config, { ...snapshot, schemaVersion: 2 as 1 }),
    ).toThrowError(CoreMindError);
    expect(() =>
      LoopController.restore(createController().config, {
        ...snapshot,
        configFingerprint: "other",
      }),
    ).toThrowError(/配置指纹/);
    expect(() =>
      LoopController.restore(createController().config, { ...snapshot, runId: "other" }),
    ).toThrowError(/runId/);
  });

  it("拒绝非法配置和内容损坏的快照", () => {
    expect(() => createController({ runId: "" })).toThrowError(/runId/);
    expect(() => createController({ maxIterations: 0 })).toThrowError(/迭代和修复上限/);

    const snapshot = createController().getSnapshot();
    expect(() =>
      LoopController.restore(createController().config, {
        ...snapshot,
        iteration: -1,
      }),
    ).toThrowError(/快照内容无效/);
  });

  it("可恢复带完整失败字段的终态快照，且终态不再迁移", () => {
    const controller = createController();
    controller.send({ type: "START" });
    controller.send({ type: "FAIL", code: "deterministic_failure", message: "确定性失败" });
    const restored = LoopController.restore(controller.config, controller.getSnapshot());

    expect(restored.getSnapshot()).toMatchObject({
      phase: "failed",
      failureCode: "deterministic_failure",
      failureMessage: "确定性失败",
    });
    restored.send({ type: "ABORT" });
    expect(restored.phase).toBe("failed");
  });

  it.each([
    [{ type: "ABORT" } as const, "aborted", "aborted"],
    [{ type: "TIMEOUT" } as const, "timeout", "run_timeout"],
    [{ type: "BUDGET_EXCEEDED" } as const, "budget_exceeded", "budget_exceeded"],
  ])("把控制事件 %o 映射到既有终态", (event, phase, code) => {
    const controller = createController();
    controller.send({ type: "START" });
    controller.send(event);

    expect(controller.phase).toBe(phase);
    expect(controller.getSnapshot().failureCode).toBe(code);
  });

  it("按发送顺序只发布稳定状态迁移", () => {
    const controller = createController();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.send({ type: "START" });
    controller.send({ type: "EXECUTED", fingerprint: "candidate-a" });
    controller.send({ type: "VERIFIED", passed: false });
    unsubscribe();
    controller.send({ type: "REPAIRED", fingerprint: "candidate-b" });

    expect(listener.mock.calls.map(([event]) => [event.from, event.to])).toEqual([
      ["idle", "executing"],
      ["executing", "verifying"],
      ["verifying", "repairing"],
    ]);
    expect(listener.mock.calls.map(([event]) => event.sequence)).toEqual([1, 2, 3]);
  });
});
