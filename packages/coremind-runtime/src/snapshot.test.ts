import { recoveryDispositionFor, resolveToolCapability } from "coremind-tools";
import { describe, expect, it } from "vitest";
import { createRunSnapshot } from "./snapshot.js";

describe("RunSnapshot", () => {
  it("生成可 JSON 序列化且不含 Map 的统一入口快照", () => {
    const snapshot = createRunSnapshot({
      runId: "run-1",
      operation: {
        schemaVersion: 1,
        operationId: "operation-1",
        runId: "run-1",
        correlationId: "run-1:operation-1",
        state: "paused",
        transitionSequence: 3,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      },
      outcome: { status: "paused", finishReason: "approval_denied" },
      metrics: {
        durationMs: 1,
        turns: 1,
        steps: { total: 0, succeeded: 0, failed: 0 },
        toolCalls: 1,
        toolFailures: 0,
        retries: 0,
        outputChars: 0,
      },
      evaluation: {
        profile: "strict",
        scenarioResults: [],
        qualityScores: {},
        securityFindings: [],
      },
      releaseReadiness: { ready: false, blockers: ["运行暂停"], warnings: [] },
      trace: [
        {
          eventId: "event-1",
          runId: "run-1",
          sequence: 1,
          timestamp: "2026-08-11T00:00:00.000Z",
          event: {
            type: "tool_call",
            agent: "main",
            tool: "write",
            args: { path: "article.md" },
            callId: "call-1",
            idempotencyKey: "run-1:call-1",
          },
        },
        {
          eventId: "event-2",
          runId: "run-1",
          sequence: 2,
          timestamp: "2026-08-11T00:00:01.000Z",
          event: {
            type: "effect_receipt",
            tool: "write",
            idempotencyKey: "run-1:call-1",
            status: "not_started",
          },
        },
      ],
      checkpoints: [],
      artifacts: [],
      extensions: [],
    });

    expect(snapshot).toMatchObject({ schemaVersion: 1, runId: "run-1", resumable: true });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("副作用状态未知时不宣称快照可恢复", () => {
    const base = {
      runId: "run-1",
      operation: {
        schemaVersion: 1 as const,
        operationId: "operation-1",
        runId: "run-1",
        correlationId: "run-1:operation-1",
        state: "paused" as const,
        transitionSequence: 3,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      },
      outcome: { status: "paused" as const, finishReason: "interrupted" },
      metrics: {
        durationMs: 1,
        turns: 1,
        steps: { total: 0, succeeded: 0, failed: 0 },
        toolCalls: 1,
        toolFailures: 0,
        retries: 0,
        outputChars: 0,
      },
      evaluation: {
        profile: "strict" as const,
        scenarioResults: [],
        qualityScores: {},
        securityFindings: [],
      },
      releaseReadiness: { ready: false, blockers: ["运行暂停"], warnings: [] },
      checkpoints: [],
      artifacts: [],
      extensions: [],
    };
    const trace = [
      {
        eventId: "event-1",
        runId: "run-1",
        sequence: 1,
        timestamp: "2026-08-11T00:00:00.000Z",
        event: {
          type: "tool_call" as const,
          agent: "main",
          tool: "write",
          args: {},
          callId: "call-1",
          idempotencyKey: "run-1:call-1",
        },
      },
      {
        eventId: "event-2",
        runId: "run-1",
        sequence: 2,
        timestamp: "2026-08-11T00:00:01.000Z",
        event: {
          type: "effect_receipt" as const,
          tool: "write",
          idempotencyKey: "run-1:call-1",
          status: "unknown" as const,
        },
      },
    ];

    expect(createRunSnapshot({ ...base, trace }).resumable).toBe(false);
  });

  it("replay-safe 工具无收据也不影响 resumable（安全门单点语义）", () => {
    const capability = resolveToolCapability({ tool: "read" });
    const snapshot = createRunSnapshot({
      runId: "run-1",
      operation: {
        schemaVersion: 1,
        operationId: "operation-1",
        runId: "run-1",
        correlationId: "run-1:operation-1",
        state: "paused",
        transitionSequence: 3,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      },
      outcome: { status: "paused", finishReason: "interrupted" },
      metrics: {
        durationMs: 1,
        turns: 1,
        steps: { total: 0, succeeded: 0, failed: 0 },
        toolCalls: 1,
        toolFailures: 0,
        retries: 0,
        outputChars: 0,
      },
      evaluation: {
        profile: "standard",
        scenarioResults: [],
        qualityScores: {},
        securityFindings: [],
      },
      releaseReadiness: { ready: false, blockers: ["运行暂停"], warnings: [] },
      trace: [
        {
          eventId: "event-1",
          runId: "run-1",
          sequence: 1,
          timestamp: "2026-08-11T00:00:00.000Z",
          event: {
            type: "capability_resolved",
            agent: "main",
            tool: "read",
            callId: "call-1",
            capability,
            recoveryDisposition: recoveryDispositionFor(capability),
          },
        },
        {
          eventId: "event-2",
          runId: "run-1",
          sequence: 2,
          timestamp: "2026-08-11T00:00:01.000Z",
          event: { type: "tool_call", agent: "main", tool: "read", callId: "call-1" },
        },
      ],
      checkpoints: [],
      artifacts: [],
      extensions: [],
    });

    expect(snapshot.resumable).toBe(true);
  });

  it("无 idempotencyKey 的非安全工具视为不安全（与恢复计划判定一致）", () => {
    const snapshot = createRunSnapshot({
      runId: "run-1",
      operation: {
        schemaVersion: 1,
        operationId: "operation-1",
        runId: "run-1",
        correlationId: "run-1:operation-1",
        state: "paused",
        transitionSequence: 3,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:01.000Z",
      },
      outcome: { status: "paused", finishReason: "interrupted" },
      metrics: {
        durationMs: 1,
        turns: 1,
        steps: { total: 0, succeeded: 0, failed: 0 },
        toolCalls: 1,
        toolFailures: 0,
        retries: 0,
        outputChars: 0,
      },
      evaluation: {
        profile: "standard",
        scenarioResults: [],
        qualityScores: {},
        securityFindings: [],
      },
      releaseReadiness: { ready: false, blockers: ["运行暂停"], warnings: [] },
      trace: [
        {
          eventId: "event-1",
          runId: "run-1",
          sequence: 1,
          timestamp: "2026-08-11T00:00:00.000Z",
          event: { type: "tool_call", agent: "main", tool: "send_email", callId: "call-1" },
        },
      ],
      checkpoints: [],
      artifacts: [],
      extensions: [],
    });

    expect(snapshot.resumable).toBe(false);
  });

  it("拒绝混入其他运行的 operation", () => {
    expect(() =>
      createRunSnapshot({
        runId: "run-1",
        operation: {
          schemaVersion: 1,
          operationId: "operation-2",
          runId: "run-2",
          correlationId: "run-2:operation-2",
          state: "completed",
          transitionSequence: 3,
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:01.000Z",
        },
        outcome: { status: "succeeded", finishReason: "completed" },
        metrics: {
          durationMs: 1,
          turns: 1,
          steps: { total: 0, succeeded: 0, failed: 0 },
          toolCalls: 0,
          toolFailures: 0,
          retries: 0,
          outputChars: 0,
        },
        evaluation: {
          profile: "standard",
          scenarioResults: [],
          qualityScores: {},
          securityFindings: [],
        },
        releaseReadiness: { ready: false, blockers: [], warnings: [] },
        trace: [],
        checkpoints: [],
        artifacts: [],
        extensions: [],
      }),
    ).toThrow("operation.runId");
  });
});
