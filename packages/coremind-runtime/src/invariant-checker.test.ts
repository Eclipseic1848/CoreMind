import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { checkInvariantFacts, type InvariantFacts } from "./invariant-checker.js";
import type { RunStateRecord } from "./run-state.js";

function record(
  sequence: number,
  payload: unknown = {},
  kind: RunStateRecord["kind"] = sequence === 1 ? "start" : "event",
): RunStateRecord {
  return {
    version: 1,
    runId: "run-1",
    sequence,
    timestamp: "2026-08-20T00:00:00.000Z",
    kind,
    payload,
  };
}

function eventRecord(sequence: number, event: CoreMindEvent): RunStateRecord {
  return record(
    sequence,
    {
      eventId: `event-${sequence}`,
      runId: "run-1",
      sequence,
      timestamp: "2026-08-20T00:00:00.000Z",
      event,
    },
    "event",
  );
}

describe("关联不变量检查器", () => {
  it("生产默认 off：不执行检查", () => {
    expect(checkInvariantFacts({ runRecords: [record(1), record(3)] })).toEqual([]);
  });

  it("I-1：检出 journal sequence 空洞", () => {
    const violations = checkInvariantFacts(
      { runRecords: [record(1), record(3)] },
      { mode: "eval" },
    );

    expect(violations).toMatchObject([{ invariant: "I-1", runId: "run-1", sequence: 3 }]);
  });

  it("I-2：检出同 sequence 的异内容记录", () => {
    const violations = checkInvariantFacts(
      { runRecords: [record(1, { value: "first" }), record(1, { value: "conflict" })] },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-2", runId: "run-1", sequence: 1 }),
    );
  });

  it("I-2：允许同 sequence 同内容的幂等追加", () => {
    const duplicate = record(1, { value: "same" });
    const violations = checkInvariantFacts(
      { runRecords: [duplicate, structuredClone(duplicate)] },
      { mode: "eval" },
    );

    expect(violations).toEqual([]);
  });

  it("I-3：检出 finish 之后追加的新记录", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          record(2, { status: "succeeded" }, "finish"),
          record(3, {}, "event"),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-3", runId: "run-1", sequence: 3 }),
    );
  });

  it("I-4：检出 Run 内重复启动的 StepId", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "step_start", stepId: "step-1", kind: "agent" }),
          eventRecord(3, { type: "step_start", stepId: "step-1", kind: "agent" }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-4", runId: "run-1", sequence: 3 }),
    );
  });

  it("I-5：检出 Call 与当前 Turn 不匹配", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(3, {
            type: "tool_call",
            agent: "main",
            tool: "read",
            args: {},
            callId: "call-1",
            turnId: "turn-2",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-5", runId: "run-1", sequence: 3 }),
    );
  });

  it("I-5：允许 turn_end 后的工具事件归属刚结束的 Turn", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(3, { type: "turn_end", agent: "main", turnId: "turn-1" }),
          eventRecord(4, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            turnId: "turn-1",
            idempotencyKey: "run-1:call-1",
          }),
          eventRecord(5, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
            turnId: "turn-1",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-5")).toEqual([]);
  });

  it("I-5：检出与当前活动 Turn 不匹配的 turn_end", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(3, { type: "turn_end", agent: "main", turnId: "turn-2" }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-5", runId: "run-1", sequence: 3 }),
    );
  });

  it("I-5：允许 text_delta 开启后续 Turn 并由 turn_end 定案身份", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(3, { type: "turn_end", agent: "main", turnId: "turn-1" }),
          eventRecord(4, { type: "text_delta", agent: "main", delta: "下一轮" }),
          eventRecord(5, { type: "turn_end", agent: "main", turnId: "turn-2" }),
          eventRecord(6, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-2",
            turnId: "turn-2",
            idempotencyKey: "run-1:call-2",
          }),
          eventRecord(7, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-2",
            tool: "write",
            status: "not_started",
            turnId: "turn-2",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-5")).toEqual([]);
  });

  it("I-5：允许缺少历史 agent_start 时由 text_delta 与 turn_end 定案 Turn", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "text_delta", agent: "main", delta: "历史流" }),
          eventRecord(3, { type: "turn_end", agent: "main", turnId: "turn-1" }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-5")).toEqual([]);
  });

  it("I-5：检出 Run 与 Session 事实的关联键不匹配", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1, { sessionId: "session-1", sessionSeqStart: 1, turnSeqStart: 1 }, "start"),
        ],
        session: {
          sessionId: "session-2",
          entries: [{ id: "entry-1", seq: 1 }],
        },
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-5", runId: "run-1", sequence: 1 }),
    );
  });

  it("I-5：检出超出 Session 事实水位的 sessionSeqStart", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1, { sessionId: "session-1", sessionSeqStart: 2, turnSeqStart: 2 }, "start"),
        ],
        session: {
          sessionId: "session-1",
          entries: [{ id: "entry-1", seq: 1 }],
        },
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-5", runId: "run-1", sequence: 1 }),
    );
  });

  it("I-6：检出与 Run、Step、Call 不匹配的 ReceiptId", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            stepId: "step-1",
            idempotencyKey: "another-run:step-1:call-1",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-6", runId: "run-1", sequence: 2 }),
    );
  });

  it("I-6：检出 EffectReceipt 的跨 Run 前缀", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "effect_receipt",
            idempotencyKey: "run-2:call-1",
            tool: "write",
            status: "not_started",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-6", receiptId: "run-2:call-1" }),
    );
  });

  it("I-6：检出无法回溯到同一 Call 的 EffectReceipt", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
          eventRecord(3, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-2",
            tool: "write",
            status: "not_started",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-6", receiptId: "run-1:call-2" }),
    );
  });

  it("I-7：检出没有可解释终结的工具 Call", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-7", runId: "run-1", callId: "call-1" }),
    );
  });

  it("I-7：检出具有多个终态收据的工具 Call", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
          eventRecord(3, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
          }),
          eventRecord(4, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-7", runId: "run-1", callId: "call-1" }),
    );
  });

  it("I-7：允许 aborted Run 显式关闭在飞 Call", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
          record(3, { status: "aborted" }, "finish"),
        ],
      },
      { mode: "eval" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-7")).toEqual([]);
  });

  it("I-7：aborted Run 仍会检出已有多个终结的工具 Call", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
          eventRecord(3, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
          }),
          eventRecord(4, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
          }),
          record(5, { status: "aborted" }, "finish"),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-7", runId: "run-1", callId: "call-1" }),
    );
  });

  it("I-8：检出归属于其他 Run 的 Checkpoint", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [record(1)],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-1",
            runId: "run-2",
            timestamp: "2026-08-20T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-1.json",
          },
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-8", checkpointId: "checkpoint-1" }),
    );
  });

  it("I-8：检出与 Operation 不匹配的 Checkpoint", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          record(
            2,
            {
              schemaVersion: 1,
              operationId: "operation-1",
              runId: "run-1",
              correlationId: "run-1:operation-1",
              sequence: 1,
              eventId: "operation-event-1",
              event: "ACCEPT",
              from: null,
              to: "accepted",
              timestamp: "2026-08-20T00:00:00.000Z",
            },
            "operation",
          ),
        ],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-1",
            runId: "run-1",
            operationId: "operation-2",
            timestamp: "2026-08-20T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-1.json",
          },
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-8", checkpointId: "checkpoint-1" }),
    );
  });

  it("I-8：检出无法回溯到同一 Call 的 Checkpoint", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
          eventRecord(3, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
          }),
        ],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-1",
            runId: "run-1",
            toolCallId: "call-2",
            idempotencyKey: "run-1:call-2",
            timestamp: "2026-08-20T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-1.json",
          },
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-8", checkpointId: "checkpoint-1" }),
    );
  });

  it("I-9：检出未与 required 配对的 ApprovalId", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "approval_required",
            approvalId: "approval-1",
            runId: "run-1",
            agent: "main",
            tool: "write",
            args: {},
            risk: "high",
            effect: {
              operations: ["write"],
              paths: ["file.txt"],
              urls: [],
              reversible: true,
              declared: true,
            },
          }),
          eventRecord(3, {
            type: "approval_resolved",
            approvalId: "approval-2",
            runId: "run-1",
            decision: "allow",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-9", approvalId: "approval-2" }),
    );
  });

  it("I-9：检出重复的 approval_required", () => {
    const required = {
      type: "approval_required" as const,
      approvalId: "approval-1",
      runId: "run-1",
      agent: "main",
      tool: "write",
      args: {},
      risk: "high" as const,
      effect: {
        operations: ["write" as const],
        paths: ["file.txt"],
        urls: [],
        reversible: true,
        declared: true,
      },
    };
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, required),
          eventRecord(3, required),
          eventRecord(4, {
            type: "approval_resolved",
            approvalId: "approval-1",
            runId: "run-1",
            decision: "allow",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-9", approvalId: "approval-1", sequence: 3 }),
    );
  });

  it("I-10：检出 Abort 分界点后的迟到终态事实", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          record(
            2,
            {
              schemaVersion: 1,
              operationId: "operation-1",
              runId: "run-1",
              correlationId: "run-1:operation-1",
              sequence: 2,
              eventId: "operation-event-2",
              event: "REQUEST_ABORT",
              from: "running",
              to: "aborting",
              timestamp: "2026-08-20T00:00:00.000Z",
            },
            "operation",
          ),
          eventRecord(3, { type: "turn_end", agent: "main" }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-10", runId: "run-1", sequence: 3 }),
    );
  });

  it("I-11：检出不是以 ACCEPT 开始的 Operation 事件链", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          record(
            2,
            {
              schemaVersion: 1,
              operationId: "operation-1",
              runId: "run-1",
              correlationId: "run-1:operation-1",
              sequence: 1,
              eventId: "operation-event-1",
              event: "START",
              from: "accepted",
              to: "running",
              timestamp: "2026-08-20T00:00:00.000Z",
            },
            "operation",
          ),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-11", runId: "run-1" }),
    );
  });

  it("I-12：检出 EffectReceipt 状态回退", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "started",
          }),
          eventRecord(3, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "not_started",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-12", receiptId: "run-1:call-1" }),
    );
  });

  it("gate：合法 fixture 对 I-1 至 I-12 输出零 violation", () => {
    const operationBase = {
      schemaVersion: 1 as const,
      operationId: "operation-1",
      runId: "run-1",
      correlationId: "run-1:operation-1",
      timestamp: "2026-08-20T00:00:00.000Z",
    };
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1, { sessionId: "session-1", sessionSeqStart: 1, turnSeqStart: 1 }),
          record(
            2,
            {
              ...operationBase,
              sequence: 1,
              eventId: "operation-event-1",
              event: "ACCEPT",
              from: null,
              to: "accepted",
            },
            "operation",
          ),
          record(
            3,
            {
              ...operationBase,
              sequence: 2,
              eventId: "operation-event-2",
              event: "START",
              from: "accepted",
              to: "running",
            },
            "operation",
          ),
          eventRecord(4, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(5, { type: "step_start", stepId: "step-1", kind: "agent" }),
          eventRecord(6, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            stepId: "step-1",
            turnId: "turn-1",
            idempotencyKey: "run-1:step-1:call-1",
          }),
          eventRecord(7, {
            type: "approval_required",
            approvalId: "approval-1",
            runId: "run-1",
            agent: "main",
            tool: "write",
            args: {},
            risk: "high",
            effect: {
              operations: ["write"],
              paths: ["file.txt"],
              urls: [],
              reversible: true,
              declared: true,
            },
          }),
          eventRecord(8, {
            type: "approval_resolved",
            approvalId: "approval-1",
            runId: "run-1",
            decision: "allow",
          }),
          eventRecord(9, {
            type: "effect_receipt",
            idempotencyKey: "run-1:step-1:call-1",
            tool: "write",
            status: "started",
            stepId: "step-1",
            turnId: "turn-1",
          }),
          eventRecord(10, {
            type: "tool_result",
            agent: "main",
            tool: "write",
            isError: false,
            callId: "call-1",
            stepId: "step-1",
            turnId: "turn-1",
            idempotencyKey: "run-1:step-1:call-1",
          }),
          eventRecord(11, {
            type: "effect_receipt",
            idempotencyKey: "run-1:step-1:call-1",
            tool: "write",
            status: "committed",
            stepId: "step-1",
            turnId: "turn-1",
          }),
          eventRecord(12, { type: "turn_end", agent: "main", turnId: "turn-1" }),
          eventRecord(13, { type: "step_end", stepId: "step-1", ok: true }),
          record(14, { status: "succeeded" }, "finish"),
        ],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-1",
            runId: "run-1",
            operationId: "operation-1",
            toolCallId: "call-1",
            idempotencyKey: "run-1:step-1:call-1",
            timestamp: "2026-08-20T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-1.json",
          },
        ],
        session: {
          sessionId: "session-1",
          entries: [{ id: "entry-1", seq: 1 }],
        },
      },
      { mode: "gate" },
    );

    expect(violations).toEqual([]);
  });

  it("gate：全部受跟踪 fixture 对 I-1 至 I-12 输出零 violation", () => {
    const fixtureDirectory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../test-fixtures/invariant-checker",
    );
    const fixtureFiles = ["current-correlated.json", "legacy-0.3.0.json"];

    for (const fixtureFile of fixtureFiles) {
      const file = path.join(fixtureDirectory, fixtureFile);
      const facts = JSON.parse(readFileSync(file, "utf8")) as InvariantFacts;
      expect(checkInvariantFacts(facts, { mode: "gate" }), fixtureFile).toEqual([]);
    }
  });

  it("0.3.0：缺少 TurnId 且复用旧 loop StepId 时按声明降级", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1, { configFingerprint: "legacy" }, "start"),
          eventRecord(2, { type: "agent_start", agent: "main" }),
          eventRecord(3, { type: "step_start", stepId: "loop-execute", kind: "agent" }),
          eventRecord(4, { type: "step_end", stepId: "loop-execute", ok: true }),
          eventRecord(5, { type: "step_start", stepId: "loop-execute", kind: "agent" }),
          eventRecord(6, { type: "step_end", stepId: "loop-execute", ok: true }),
          eventRecord(7, { type: "turn_end", agent: "main" }),
        ],
      },
      { mode: "gate" },
    );

    expect(violations).toEqual([]);
  });

  it("0.3.0：旧 Run 在新版 Resume 后仍按事实发生边界降级", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1, { configFingerprint: "legacy" }, "start"),
          eventRecord(2, { type: "agent_start", agent: "main" }),
          eventRecord(3, { type: "step_start", stepId: "loop-execute", kind: "loop_execute" }),
          eventRecord(4, { type: "step_end", stepId: "loop-execute", ok: true }),
          eventRecord(5, { type: "step_start", stepId: "loop-execute", kind: "loop_execute" }),
          eventRecord(6, { type: "step_end", stepId: "loop-execute", ok: true }),
          record(7, { completedStepIds: [] }, "resume"),
          eventRecord(8, { type: "agent_start", agent: "main", turnId: "turn-new" }),
          eventRecord(9, { type: "turn_end", agent: "main", turnId: "turn-new" }),
        ],
      },
      { mode: "gate" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-4")).toEqual([]);
  });

  it("I-4：带 TurnId 的新 Run 不能复用旧 loop StepId", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1, { configFingerprint: "current" }, "start"),
          eventRecord(2, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(3, { type: "step_start", stepId: "loop-execute", kind: "loop_execute" }),
          eventRecord(4, { type: "step_end", stepId: "loop-execute", ok: true }),
          eventRecord(5, { type: "step_start", stepId: "loop-execute", kind: "loop_execute" }),
          eventRecord(6, { type: "step_end", stepId: "loop-execute", ok: true }),
          eventRecord(7, { type: "turn_end", agent: "main", turnId: "turn-1" }),
        ],
      },
      { mode: "gate" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-4", runId: "run-1", sequence: 5 }),
    );
  });

  it("I-7：工具失败事件可独立关闭 Call，重复失败会被检出", () => {
    const runRecords = [
      record(1),
      eventRecord(2, {
        type: "tool_call",
        agent: "main",
        tool: "write",
        args: {},
        callId: "call-1",
        idempotencyKey: "run-1:call-1",
      }),
      eventRecord(3, {
        type: "tool_result",
        agent: "main",
        tool: "write",
        isError: true,
        callId: "call-1",
        idempotencyKey: "run-1:call-1",
      }),
    ];
    expect(
      checkInvariantFacts({ runRecords }, { mode: "eval" }).filter(
        (violation) => violation.invariant === "I-7",
      ),
    ).toEqual([]);

    const duplicateFailure = checkInvariantFacts(
      {
        runRecords: [
          ...runRecords,
          eventRecord(4, {
            type: "tool_result",
            agent: "main",
            tool: "write",
            isError: true,
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          }),
        ],
      },
      { mode: "eval" },
    );
    expect(duplicateFailure).toContainEqual(
      expect.objectContaining({ invariant: "I-7", callId: "call-1" }),
    );
  });

  it("I-10：允许 Abort 后的非终态事实和分界前 Turn 的收据终态", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, { type: "agent_start", agent: "main", turnId: "turn-1" }),
          eventRecord(3, {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: {},
            callId: "call-1",
            turnId: "turn-1",
            idempotencyKey: "run-1:call-1",
          }),
          eventRecord(4, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "started",
            turnId: "turn-1",
          }),
          record(
            5,
            {
              schemaVersion: 1,
              operationId: "operation-1",
              runId: "run-1",
              correlationId: "run-1:operation-1",
              sequence: 2,
              eventId: "operation-event-2",
              event: "REQUEST_ABORT",
              from: "running",
              to: "aborting",
              timestamp: "2026-08-20T00:00:00.000Z",
            },
            "operation",
          ),
          eventRecord(6, { type: "text_delta", agent: "main", delta: "收尾" }),
          eventRecord(7, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "committed",
            turnId: "turn-1",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-10")).toEqual([]);
  });

  it("I-10：检出 Abort 后无分界前 Turn 归属的收据终态", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          record(
            2,
            {
              schemaVersion: 1,
              operationId: "operation-1",
              runId: "run-1",
              correlationId: "run-1:operation-1",
              sequence: 2,
              eventId: "operation-event-2",
              event: "REQUEST_ABORT",
              from: "running",
              to: "aborting",
              timestamp: "2026-08-20T00:00:00.000Z",
            },
            "operation",
          ),
          eventRecord(3, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "committed",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(expect.objectContaining({ invariant: "I-10", sequence: 3 }));
  });

  it("I-11：缺少身份或非对象 payload 的 Operation 记录失败关闭", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [record(1), record(2, null, "operation"), record(3, {}, "operation")],
      },
      { mode: "eval" },
    );

    expect(violations.filter((violation) => violation.invariant === "I-11")).toHaveLength(2);
  });

  it("I-12：首个收据状态不能直接是 committed", () => {
    const violations = checkInvariantFacts(
      {
        runRecords: [
          record(1),
          eventRecord(2, {
            type: "effect_receipt",
            idempotencyKey: "run-1:call-1",
            tool: "write",
            status: "committed",
          }),
        ],
      },
      { mode: "eval" },
    );

    expect(violations).toContainEqual(
      expect.objectContaining({ invariant: "I-12", receiptId: "run-1:call-1" }),
    );
  });

  it("兼容空终态 payload、resume Session 关联与数组幂等记录", () => {
    const sessionViolations = checkInvariantFacts(
      {
        runRecords: [
          record(1, null, "start"),
          record(2, { sessionId: "session-1", sessionSeqStart: 0, turnSeqStart: 0 }, "resume"),
          record(3, null, "finish"),
        ],
        session: { sessionId: "session-1", entries: [] },
      },
      { mode: "eval" },
    );
    expect(sessionViolations).toEqual([]);

    const arrayRecord = record(1, [1, { value: "same" }]);
    expect(
      checkInvariantFacts(
        { runRecords: [arrayRecord, structuredClone(arrayRecord)] },
        { mode: "eval" },
      ),
    ).toEqual([]);
  });
});
