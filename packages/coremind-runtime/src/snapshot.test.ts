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
      trace: [],
      checkpoints: [],
      artifacts: [],
      extensions: [],
    });

    expect(snapshot).toMatchObject({ schemaVersion: 1, runId: "run-1", resumable: true });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
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
