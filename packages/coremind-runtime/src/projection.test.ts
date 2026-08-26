import { createHash } from "node:crypto";
import type { ArtifactRecord } from "coremind-tools";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.js";
import type { CheckpointRecord } from "./checkpoint.js";
import { claimInput, completeInput, createInputReceipt, type InputId } from "./input-receipt.js";
import { ProjectionEngine } from "./projection.js";
import type { RunStateRecord } from "./run-state.js";
import type { CoreMindTraceEvent } from "./trace.js";

describe("ProjectionEngine", () => {
  it("只从同一 Fact 前缀重建终态、恢复、资源、控制与观测投影", () => {
    const runId = "run-projection";
    const trace: CoreMindTraceEvent[] = [
      traceEntry(runId, 1, {
        type: "approval_required",
        approvalId: "approval-1",
        runId,
        agent: "main",
        tool: "write",
        args: { path: "notes.txt" },
        risk: "high",
        effect: {
          operations: ["write"],
          paths: ["notes.txt"],
          urls: [],
          reversible: true,
          declared: true,
        },
      }),
      traceEntry(runId, 2, {
        type: "artifact_created",
        artifactId: "artifact-1",
        status: "stored",
        sizeBytes: 12,
        relativePath: ".coremind/artifacts/artifact-1.log",
        sha256: "abc123",
        mediaType: "text/plain; charset=utf-8",
        redaction: "none",
        tool: "write",
        callId: "call-1",
      }),
      traceEntry(runId, 3, {
        type: "extension_lifecycle",
        extensionId: "audit-extension",
        extensionVersion: "1.0.0",
        lifecycle: "after-tool",
        status: "succeeded",
        durationMs: 3,
      }),
    ];
    const checkpoint: CheckpointRecord = {
      version: 1,
      checkpointId: "checkpoint-1",
      runId,
      tool: "write",
      timestamp: "2026-08-24T00:00:03.000Z",
      reversible: true,
      snapshotFile: "checkpoint-1.json",
    };
    const artifact: ArtifactRecord = {
      artifactId: "artifact-1",
      status: "stored",
      sizeBytes: 12,
      relativePath: ".coremind/artifacts/artifact-1.log",
      sha256: "abc123",
      mediaType: "text/plain; charset=utf-8",
      createdAt: "2026-08-24T00:00:00.500Z",
      retention: "run",
      redaction: "none",
    };
    const extension = {
      extensionId: "audit-extension",
      extensionVersion: "1.0.0",
      event: "after-tool" as const,
      status: "succeeded" as const,
      durationMs: 3,
    };
    const operation = {
      schemaVersion: 1 as const,
      operationId: "operation-1",
      runId,
      correlationId: `${runId}:operation-1`,
      state: "paused" as const,
      transitionSequence: 3,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:04.000Z",
    };
    const outcome = { status: "paused" as const, finishReason: "approval_required" };
    const metrics = {
      durationMs: 4,
      turns: 1,
      steps: { total: 1, succeeded: 0, failed: 0 },
      toolCalls: 1,
      toolFailures: 0,
      retries: 0,
      outputChars: 0,
    };
    const evaluation = {
      profile: "standard" as const,
      scenarioResults: [],
      qualityScores: {},
      securityFindings: [],
    };
    const releaseReadiness = { ready: false, blockers: ["运行暂停"], warnings: [] };
    const records: RunStateRecord[] = [
      record(runId, 1, "start", { configName: "projection" }),
      ...trace.map((entry, index) => record(runId, index + 2, "event", entry)),
      record(runId, 5, "checkpoint", checkpoint),
      record(runId, 6, "pause", {
        operation,
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
        artifacts: [artifact],
        extensions: [extension],
      }),
    ];

    const projection = ProjectionEngine.project(records);

    expect(projection).toEqual({
      schemaVersion: 1,
      runId,
      status: "paused",
      resumable: true,
      operation,
      outcome,
      recovery: { resumable: true, operation },
      trace,
      checkpoints: [checkpoint],
      artifacts: [artifact],
      extensions: [extension],
      context: {
        stablePrefixes: [],
        budgets: [],
        compactions: [],
        failures: [],
        lifecycleFailures: [],
      },
      pendingControls: [
        {
          type: "approval",
          approvalId: "approval-1",
          runId,
          agent: "main",
          tool: "write",
          risk: "high",
        },
      ],
      observability: {
        schemaVersion: 1,
        localEnabled: true,
        derivedFromSequence: 6,
        run: {
          status: "paused",
          operationState: "paused",
          resumable: true,
          durationMs: 4,
        },
        turns: { started: 0, completed: 0, active: 0 },
        calls: { started: 0, completed: 0, failed: 0, active: 0, durationMs: 0 },
        tools: [],
        errors: [],
        context: { budgets: 0, compactions: 0, failures: 0 },
        artifacts: { stored: 1, blocked: 0 },
        sharedState: { pendingControls: 1 },
        recovery: { resumable: true, operationState: "paused" },
        telemetry: {
          mode: "DISABLED",
          source: "legacy_default",
          exporterLoaded: false,
          contentLevel: "metrics_only",
          allowedFields: [],
          queued: 0,
          handedOff: 0,
          failed: 0,
          dropped: 0,
          duplicates: 0,
          shutdownTimedOut: false,
          deliverySemantics: "best_effort_handoff_not_delivery",
          authorizedScopes: [],
        },
      },
      records,
      snapshot: {
        schemaVersion: 1,
        runId,
        operation,
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
        trace,
        checkpoints: [checkpoint],
        artifacts: expect.any(Array),
        extensions: expect.any(Array),
        resumable: true,
      },
    });
    expect(projection.snapshot?.artifacts).toEqual(projection.artifacts);
    expect(projection.snapshot?.extensions).toEqual(projection.extensions);
  });

  it("legacy 前缀只按已知 Facts 降级，混入其他 runId 时失败关闭", () => {
    const runId = "run-legacy";
    const interrupted = [
      record(runId, 1, "start", { configName: "legacy" }),
      record(
        runId,
        2,
        "event",
        traceEntry(runId, 1, {
          type: "approval_required",
          approvalId: "approval-legacy",
          runId,
          agent: "main",
          tool: "write",
          args: {},
          risk: "high",
          effect: {
            operations: ["write"],
            paths: [],
            urls: [],
            reversible: true,
            declared: true,
          },
        }),
      ),
      record(
        runId,
        3,
        "event",
        traceEntry(runId, 2, {
          type: "context_prefix",
          agent: "main",
          fingerprint: "prefix-fingerprint",
        }),
      ),
      record(
        runId,
        4,
        "event",
        traceEntry(runId, 3, {
          type: "context_compacted",
          beforeTokens: 120,
          afterTokens: 60,
          removedMessages: 4,
          strategy: "deterministic-v1",
          reason: "threshold",
          summaryFingerprint: "summary-fingerprint",
          sessionEntryId: "session-entry-1",
        }),
      ),
      record(
        runId,
        5,
        "event",
        traceEntry(runId, 4, {
          type: "artifact_created",
          artifactId: "artifact-legacy",
          status: "stored",
          sizeBytes: 6,
          mediaType: "text/plain",
          redaction: "none",
          tool: "write",
          callId: "call-legacy",
        }),
      ),
    ];

    const projection = ProjectionEngine.project(interrupted);

    expect(projection).toMatchObject({
      runId,
      status: "interrupted",
      resumable: true,
      pendingControls: [{ approvalId: "approval-legacy" }],
      context: {
        stablePrefixes: [{ agent: "main", fingerprint: "prefix-fingerprint" }],
        compactions: [
          {
            beforeTokens: 120,
            afterTokens: 60,
            removedMessages: 4,
            strategy: "deterministic-v1",
            reason: "threshold",
            summaryFingerprint: "summary-fingerprint",
            sessionEntryId: "session-entry-1",
          },
        ],
        failures: [],
      },
    });
    expect(projection).not.toHaveProperty("operation");
    expect(projection).not.toHaveProperty("outcome");
    expect(projection).not.toHaveProperty("snapshot");
    expect(projection.artifacts).toEqual([
      {
        artifactId: "artifact-legacy",
        status: "stored",
        sizeBytes: 6,
        mediaType: "text/plain",
        redaction: "none",
      },
    ]);
    expect(() =>
      ProjectionEngine.project([interrupted[0]!, { ...interrupted[1]!, runId: "run-other" }]),
    ).toThrow("身份或 sequence 不连续");
  });

  it("从 Control Facts 投影 accepted 控制，并在 applied 后移出 pending", () => {
    const runId = "run-pending-control";
    const command = {
      schemaVersion: 1 as const,
      controlId: "cancel-1",
      runId,
      type: "cancel" as const,
      reason: "用户停止",
    };
    const fingerprint = createHash("sha256").update(canonicalJson(command)).digest("hex");
    const accepted = [
      record(runId, 1, "start", { configName: "pending-control" }),
      record(runId, 2, "control", {
        schemaVersion: 1,
        controlId: command.controlId,
        fingerprint,
        state: "accepted",
        command,
      }),
    ];

    expect(ProjectionEngine.project(accepted).pendingControls).toEqual([
      {
        source: "control_inbox",
        controlId: "cancel-1",
        runId,
        type: "cancel",
        acceptedSequence: 2,
        command,
      },
    ]);
    expect(
      ProjectionEngine.project([
        ...accepted,
        record(runId, 3, "control", {
          schemaVersion: 1,
          controlId: command.controlId,
          fingerprint,
          state: "applied",
        }),
      ]).pendingControls,
    ).toEqual([]);
  });

  it("resume 使旧 pause 失效，恢复中的前缀不继承旧终态", () => {
    const runId = "run-resumed";
    const projection = ProjectionEngine.project([
      record(runId, 1, "start", { configFingerprint: "fingerprint" }),
      record(runId, 2, "pause", {
        outcome: { status: "paused", finishReason: "approval_required" },
      }),
      record(runId, 3, "resume", { resumedFromSequence: 2 }),
    ]);

    expect(projection.status).toBe("interrupted");
    expect(projection.resumable).toBe(true);
    expect(projection).not.toHaveProperty("outcome");
    expect(projection).not.toHaveProperty("snapshot");
  });

  it("输入收据终态不可恢复，非法转移按损坏失败关闭", () => {
    const runId = "run-input-terminal";
    const inputId = "input-1" as InputId;
    const events = [
      createInputReceipt({ inputId, contentFingerprint: "fingerprint" }),
      claimInput({ inputId, turnId: "turn-1" }),
      completeInput({ inputId }),
    ];
    const records = [
      record(runId, 1, "start", { configFingerprint: "fingerprint" }),
      ...events.map((event, index) =>
        record(runId, index + 2, "event", traceEntry(runId, index + 1, event)),
      ),
    ];

    expect(ProjectionEngine.project(records).recovery.resumable).toBe(false);
    expect(() => ProjectionEngine.prepareResume(records, "fingerprint")).toThrowError(
      expect.objectContaining({ code: "run_already_finished" }),
    );

    const illegal = [
      ...records,
      record(runId, 5, "event", traceEntry(runId, 4, claimInput({ inputId, turnId: "turn-2" }))),
    ];
    expect(() => ProjectionEngine.project(illegal)).toThrowError(
      expect.objectContaining({ code: "run_state_corrupt" }),
    );
  });

  it("已知 Fact kind 的损坏 payload 不得静默降级", () => {
    const runId = "run-corrupt-payload";
    const start = record(runId, 1, "start", { configName: "corrupt" });

    expect(() => ProjectionEngine.project([start, record(runId, 2, "event", {})])).toThrowError(
      expect.objectContaining({ code: "run_state_corrupt" }),
    );
    expect(() =>
      ProjectionEngine.project([start, record(runId, 2, "checkpoint", { version: 1 })]),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
    expect(() =>
      ProjectionEngine.project([start, record(runId, 2, "pause", "invalid")]),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
    expect(() =>
      ProjectionEngine.project([
        start,
        record(
          runId,
          2,
          "event",
          traceEntry(runId, 1, {
            type: "artifact_created",
            artifactId: "artifact-invalid",
          } as CoreMindTraceEvent["event"]),
        ),
      ]),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
    for (const malformed of [
      { type: "text_delta", agent: "main" },
      { type: "tool_call", agent: "main", tool: "read" },
      { type: "turn_end", tokens: 1 },
    ]) {
      expect(() =>
        ProjectionEngine.project([
          start,
          record(runId, 2, "event", traceEntry(runId, 1, malformed as CoreMindTraceEvent["event"])),
        ]),
      ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
    }
    expect(() =>
      ProjectionEngine.project([
        start,
        record(runId, 2, "checkpoint", {
          version: 1,
          checkpointId: "checkpoint-invalid",
          runId,
          timestamp: "2026-08-24T00:00:01.000Z",
          tool: "write",
          reversible: true,
          snapshotFile: "checkpoint-invalid.json",
          operationId: 42,
        }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
    expect(() =>
      ProjectionEngine.project([
        start,
        record(runId, 2, "pause", {
          outcome: { status: 42, finishReason: "invalid" },
        }),
      ]),
    ).toThrowError(expect.objectContaining({ code: "run_state_corrupt" }));
  });
});

function record(
  runId: string,
  sequence: number,
  kind: RunStateRecord["kind"],
  payload: unknown,
): RunStateRecord {
  return {
    version: 1,
    runId,
    sequence,
    timestamp: `2026-08-24T00:00:0${sequence - 1}.000Z`,
    kind,
    payload,
  };
}

function traceEntry(
  runId: string,
  sequence: number,
  event: CoreMindTraceEvent["event"],
): CoreMindTraceEvent {
  return {
    eventId: `event-${sequence}`,
    runId,
    sequence,
    timestamp: `2026-08-24T00:00:0${sequence - 1}.000Z`,
    event,
  };
}
