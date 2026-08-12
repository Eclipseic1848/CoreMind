import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DurableOperation,
  type OperationState,
  restoreDurableOperation,
} from "./operation-state.js";

describe("DurableOperation", () => {
  it("按 accepted → running → paused → running → completed 保存合法状态", () => {
    const operation = DurableOperation.create({
      runId: "run-1",
      operationId: "op-1",
      eventId: "accepted-1",
      timestamp: "2026-08-10T00:00:00.000Z",
    });

    operation.transition({
      eventId: "start-1",
      type: "START",
      timestamp: "2026-08-10T00:00:01.000Z",
    });
    operation.transition({
      eventId: "pause-1",
      type: "PAUSE",
      reason: "approval",
      timestamp: "2026-08-10T00:00:02.000Z",
    });
    operation.transition({
      eventId: "resume-1",
      type: "RESUME",
      timestamp: "2026-08-10T00:00:03.000Z",
    });
    operation.transition({
      eventId: "complete-1",
      type: "COMPLETE",
      timestamp: "2026-08-10T00:00:04.000Z",
    });

    expect(operation.snapshot()).toMatchObject({
      operationId: "op-1",
      runId: "run-1",
      state: "completed",
      transitionSequence: 5,
    });
    expect(restoreDurableOperation(operation.records()).snapshot()).toEqual(operation.snapshot());
  });

  it("重复 eventId 幂等，乱序和非法迁移失败关闭", () => {
    const operation = DurableOperation.create({
      runId: "run-2",
      operationId: "op-2",
      eventId: "a",
    });
    const started = operation.transition({ eventId: "b", type: "START" });
    const duplicate = operation.transition({ eventId: "b", type: "START" });

    expect(started.changed).toBe(true);
    expect(duplicate.changed).toBe(false);
    expect(operation.snapshot().transitionSequence).toBe(2);
    expect(() => operation.transition({ eventId: "c", type: "COMPLETE" })).not.toThrow();
    expect(() => operation.transition({ eventId: "d", type: "RESUME" })).toThrowError(
      expect.objectContaining({ code: "invalid_operation_transition" }),
    );
  });

  it("恢复时拒绝真实落盘顺序乱序，不能先排序再接受", () => {
    const operation = DurableOperation.create({
      runId: "run-order",
      operationId: "op-order",
      eventId: "accepted-order",
    });
    operation.transition({ eventId: "start-order", type: "START" });
    operation.transition({ eventId: "complete-order", type: "COMPLETE" });
    const [accepted, started, completed] = operation.records();

    expect(() => restoreDurableOperation([started!, accepted!, completed!])).toThrowError(
      expect.objectContaining({ code: "operation_state_corrupt" }),
    );
  });

  it("中止先进入 aborting，再以 failed 终态保存真实原因", () => {
    const operation = DurableOperation.create({
      runId: "run-3",
      operationId: "op-3",
      eventId: "a",
    });
    operation.transition({ eventId: "b", type: "START" });
    operation.transition({ eventId: "c", type: "REQUEST_ABORT", reason: "user" });
    operation.transition({ eventId: "d", type: "FAIL", reason: "aborted" });

    expect(operation.snapshot()).toMatchObject({ state: "failed", failureReason: "aborted" });
    expect(operation.records().map((record) => record.to)).toEqual([
      "accepted",
      "running",
      "aborting",
      "failed",
    ]);
  });

  it("属性测试：任意非法目标状态都不能绕过迁移表", () => {
    const legalTargets: Record<OperationState, ReadonlySet<OperationState>> = {
      accepted: new Set(["running", "aborting", "failed"]),
      running: new Set(["paused", "aborting", "completed", "failed"]),
      paused: new Set(["running", "aborting", "failed"]),
      aborting: new Set(["failed"]),
      completed: new Set(),
      failed: new Set(),
    };
    const states: OperationState[] = [
      "accepted",
      "running",
      "paused",
      "aborting",
      "completed",
      "failed",
    ];

    fc.assert(
      fc.property(fc.constantFrom(...states), fc.constantFrom(...states), (from, to) => {
        if (from === to) return;
        expect(DurableOperation.canTransition(from, to)).toBe(legalTargets[from].has(to));
      }),
      { numRuns: 80, seed: 300_201 },
    );
  });
});
