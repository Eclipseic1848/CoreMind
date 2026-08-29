import "../../../test/setup-env.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChildRunExecutionAdapter,
  type ChildRunExecutionInput,
  childRunInputFingerprint,
} from "./child-run.js";
import {
  createCoreMindChildRunAdapter,
  isCoreMindChildRunAdapter,
} from "./child-runtime-adapter.js";
import { createEffectReceiptBinding } from "./effect-receipt-binding.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("CoreMind Child Runtime Adapter", () => {
  it("官方 wrapper 也拒绝结构相同但未经 CoreMindRuntime.create 注册的伪 Runtime", async () => {
    let authorityChecks = 0;
    const adapter = createCoreMindChildRunAdapter({
      createRuntime: async () =>
        ({
          verifyChildRunAuthority: async () => {
            authorityChecks += 1;
          },
          run: async () => ({ runId: "run-child" }),
          waitForQuiescence: async () => true,
        }) as never,
    });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_identity_mismatch",
    });
    expect(authorityChecks).toBe(0);
    expect(isCoreMindChildRunAdapter(adapter)).toBe(true);
    expect(
      isCoreMindChildRunAdapter({ execute: async () => ({}) } as ChildRunExecutionAdapter),
    ).toBe(false);
  });

  it("真实注册 Runtime 的 RunId 漂移时拒绝结果", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () => ({ runId: "run-other" }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_identity_mismatch",
    });
  });

  it("真实注册 Runtime 未静止时拒绝结构化结果", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () => ({ runId: "run-child" }) as RunResult;
    runtime.waitForQuiescence = async () => false;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_not_quiescent",
    });
  });

  it("无 Tool Call 的静止 Child Run 由 Adapter 评估为可安全重新委派", async () => {
    await expect(executeRuntimeTrace([])).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "replay_safe",
        effectState: "none",
        quiescent: true,
        executionOwnership: "released",
      },
    });
  });

  it("后代 Child 已产生 committed Effect 时不能把当前 Child 判为 replay_safe", async () => {
    await expect(
      executeRuntimeTrace([], {
        childRuns: descendantChildRuns({
          recoveryDisposition: "requires_proof",
          effectState: "committed",
          quiescent: true,
          executionOwnership: "released",
          evidence: ["event:grandchild-effect-committed"],
        }),
      }),
    ).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_proof",
        effectState: "committed",
        quiescent: true,
        executionOwnership: "released",
        evidence: expect.arrayContaining([
          "child_run:run-grandchild:event:grandchild-effect-committed",
        ]),
      },
    });
  });

  it("后代执行已静止但仍有未处置结果时要求人工且不谎报执行未静止", async () => {
    const childRuns = descendantChildRuns({
      recoveryDisposition: "replay_safe",
      effectState: "none",
      quiescent: true,
      executionOwnership: "released",
      evidence: [],
    });
    childRuns.unhandledDescendants = 1;
    childRuns.quiescent = false;

    await expect(executeRuntimeTrace([], { childRuns })).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_human",
        effectState: "none",
        quiescent: true,
        executionOwnership: "released",
        evidence: expect.arrayContaining(["child_run_tree:unhandled_descendants"]),
      },
    });
  });

  it("存在孤立 EffectReceipt 时不能按无 Tool Call 判为 replay_safe", async () => {
    const trace = [
      traceEntry("event-orphan-receipt", 1, {
        type: "effect_receipt",
        idempotencyKey: "run-child:call-missing",
        tool: "write",
        status: "not_started",
      }),
    ];
    await expect(executeRuntimeTrace(trace)).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_human",
        effectState: "unknown",
      },
    });
  });

  it("只有 replay_safe 且 effect none 的 Tool Call 时仍可安全重新委派", async () => {
    await expect(executeRuntimeTrace(safeToolTrace())).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "replay_safe",
        effectState: "none",
        quiescent: true,
        executionOwnership: "released",
      },
    });
  });

  it("Tool Call 缺少 Capability Fact 时失败关闭为人工处置", async () => {
    await expect(
      executeRuntimeTrace([
        traceEntry("event-tool-call-without-capability", 1, {
          type: "tool_call",
          agent: "main",
          tool: "write",
          args: { path: "result.txt" },
          callId: "call-without-capability",
          idempotencyKey: "run-child:call-without-capability",
          turnId: "turn-without-capability",
        }),
      ]),
    ).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_human",
        effectState: "unknown",
        quiescent: true,
        executionOwnership: "released",
      },
    });
  });

  it("绑定到非 replay-safe Call 的 not_started Receipt 可证明尚未执行", async () => {
    const trace = effectfulToolTrace("unsafe", "forbidden", ["not_started"]);
    await expect(executeRuntimeTrace(trace)).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "replay_safe",
        effectState: "not_started",
        quiescent: true,
        executionOwnership: "released",
        evidence: expect.arrayContaining(["event:event-receipt-not_started"]),
      },
    });
  });

  it("已 committed 的 idempotent Call 保留 requires_proof，不能判为 replay_safe", async () => {
    const trace = effectfulToolTrace("idempotent", "requires_proof", ["started", "committed"]);
    await expect(executeRuntimeTrace(trace)).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_proof",
        effectState: "committed",
        quiescent: true,
        executionOwnership: "released",
        evidence: expect.arrayContaining(["event:event-receipt-committed"]),
      },
    });
  });

  it("effect none Capability 与 started Receipt 冲突时失败关闭为 requires_human", async () => {
    await expect(executeRuntimeTrace(safeToolTrace("started"))).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_human",
        effectState: "started",
      },
    });
  });

  it("未绑定的 started Receipt 使 replay_safe Capability 失败关闭", async () => {
    await expect(executeRuntimeTrace(safeToolTrace("started", false))).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "requires_human",
        effectState: "unknown",
      },
    });
  });

  it.each([
    {
      name: "unsafe Call 停在 started",
      replay: "unsafe" as const,
      recoveryDisposition: "forbidden" as const,
      receiptStatuses: ["started"] as const,
      expectedDisposition: "forbidden",
      expectedEffectState: "started",
    },
    {
      name: "unknown Call 最终 Effect 状态未知",
      replay: "unknown" as const,
      recoveryDisposition: "requires_human" as const,
      receiptStatuses: ["started", "unknown"] as const,
      expectedDisposition: "requires_human",
      expectedEffectState: "unknown",
    },
  ])(
    "$name 时不能判为 replay_safe",
    async ({
      replay,
      recoveryDisposition,
      receiptStatuses,
      expectedDisposition,
      expectedEffectState,
    }) => {
      const trace = effectfulToolTrace(replay, recoveryDisposition, receiptStatuses);
      await expect(executeRuntimeTrace(trace)).resolves.toMatchObject({
        recovery: {
          recoveryDisposition: expectedDisposition,
          effectState: expectedEffectState,
          quiescent: true,
          executionOwnership: "released",
        },
      });
    },
  );

  it("聚合整个 Child Run 时保留任一 Call 的最严格恢复约束", async () => {
    const unsafeTrace = effectfulToolTrace("unsafe", "forbidden", ["started"]).map(
      (entry, index) => ({
        ...entry,
        eventId: `mixed-${entry.eventId}`,
        sequence: index + 3,
      }),
    );
    await expect(executeRuntimeTrace([...safeToolTrace(), ...unsafeTrace])).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "forbidden",
        effectState: "started",
      },
    });
  });

  it("未绑定的 not_started Receipt 不是充分证明", async () => {
    const trace = effectfulToolTrace("unsafe", "forbidden", ["not_started"]).map((entry) =>
      entry.event.type === "effect_receipt"
        ? { ...entry, event: { ...entry.event, binding: undefined } }
        : entry,
    ) as RunResult["trace"];
    await expect(executeRuntimeTrace(trace)).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "forbidden",
        effectState: "unknown",
      },
    });
  });

  it("Child 输出不能覆盖 Adapter 从 Trace 生成的恢复评估", async () => {
    await expect(
      executeRuntimeTrace([], {
        recovery: {
          recoveryDisposition: "forbidden",
          effectState: "committed",
          quiescent: false,
          executionOwnership: "unknown",
          evidence: ["child:untrusted"],
        },
      }),
    ).resolves.toMatchObject({
      recovery: {
        recoveryDisposition: "replay_safe",
        effectState: "none",
        quiescent: true,
        executionOwnership: "released",
        evidence: expect.not.arrayContaining(["child:untrusted"]),
      },
    });
  });

  it("真实注册 Runtime 返回其他 Run 的 Checkpoint 时失败关闭", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () =>
      ({
        runId: "run-child",
        outcome: { status: "succeeded", finishReason: "completed" },
        trace: [],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-foreign",
            runId: "run-foreign",
            timestamp: "2026-08-29T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-foreign.json",
          },
        ],
      }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "child_run_identity_mismatch",
    });
  });

  it("可逆 Workspace Checkpoint 缺少写后状态时失败关闭", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () =>
      ({
        runId: "run-child",
        outcome: { status: "succeeded", finishReason: "completed" },
        trace: [],
        artifacts: [],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-incomplete",
            runId: "run-child",
            timestamp: "2026-08-29T00:00:00.000Z",
            tool: "write",
            reversible: true,
            targetPath: path.join("C:/test-workspace", "changed.txt"),
            existed: false,
            snapshotFile: "checkpoint-incomplete.json",
          },
        ],
      }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "checkpoint_failed",
    });
  });

  it("可逆 Workspace Checkpoint 缺少目标路径时失败关闭", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () =>
      ({
        runId: "run-child",
        outcome: { status: "succeeded", finishReason: "completed" },
        trace: [
          {
            eventId: "event-committed",
            runId: "run-child",
            sequence: 1,
            timestamp: "2026-08-29T00:00:00.000Z",
            event: {
              type: "effect_receipt",
              idempotencyKey: "run-child:call-without-target",
              tool: "write",
              status: "committed",
              callId: "call-without-target",
            },
          },
        ],
        artifacts: [],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-without-target",
            runId: "run-child",
            toolCallId: "call-without-target",
            idempotencyKey: "run-child:call-without-target",
            timestamp: "2026-08-29T00:00:00.000Z",
            tool: "write",
            reversible: true,
            existed: false,
            afterExisted: true,
            afterSha256: "sha256:changed",
            snapshotFile: "checkpoint-without-target.json",
          },
        ],
      }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "checkpoint_failed",
    });
  });

  it("可逆 Workspace Checkpoint 缺少写前存在状态时失败关闭", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () =>
      ({
        runId: "run-child",
        outcome: { status: "succeeded", finishReason: "completed" },
        trace: [],
        artifacts: [],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-without-before-state",
            runId: "run-child",
            timestamp: "2026-08-29T00:00:00.000Z",
            tool: "write",
            reversible: true,
            targetPath: path.join("C:/test-workspace", "changed.txt"),
            afterExisted: true,
            afterSha256: "sha256:changed",
            snapshotFile: "checkpoint-without-before-state.json",
          },
        ],
      }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "checkpoint_failed",
    });
  });

  it("明确 not_started 的可逆 Checkpoint 可忽略变化但保留证据引用", async () => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () =>
      ({
        runId: "run-child",
        outcome: { status: "aborted", finishReason: "parent_cancelled" },
        trace: [
          {
            eventId: "event-not-started",
            runId: "run-child",
            sequence: 1,
            timestamp: "2026-08-29T00:00:00.000Z",
            event: {
              type: "effect_receipt",
              idempotencyKey: "run-child:call-write",
              tool: "write",
              status: "not_started",
              agent: "main",
              callId: "call-write",
              turnId: "turn-write",
              binding: {
                version: 1,
                runId: "run-child",
                turnId: "turn-write",
                agent: "main",
                callId: "call-write",
                tool: "write",
                argumentsFingerprint: "sha256:args",
                capabilityFingerprint: "sha256:capability",
              },
            },
          },
        ],
        artifacts: [],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-not-started",
            runId: "run-child",
            toolCallId: "call-write",
            idempotencyKey: "run-child:call-write",
            timestamp: "2026-08-29T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-not-started.json",
          },
        ],
      }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).resolves.toMatchObject({
      evidence: ["event:event-not-started", "checkpoint:checkpoint-not-started"],
      workspaceChanges: [],
    });
  });

  it.each([
    {
      name: "缺少 binding",
      binding: undefined,
    },
    {
      name: "binding 工具不匹配",
      binding: {
        version: 1 as const,
        runId: "run-child",
        turnId: "turn-write",
        agent: "main",
        callId: "call-write",
        tool: "read",
        argumentsFingerprint: "sha256:args",
        capabilityFingerprint: "sha256:capability",
      },
    },
  ])("not_started $name 时不能绕过 Checkpoint 完整性检查", async ({ binding }) => {
    const runtime = await createRegisteredRuntime();
    runtime.verifyChildRunAuthority = async () => undefined;
    runtime.run = async () =>
      ({
        runId: "run-child",
        outcome: { status: "aborted", finishReason: "parent_cancelled" },
        trace: [
          {
            eventId: "event-unbound-not-started",
            runId: "run-child",
            sequence: 1,
            timestamp: "2026-08-29T00:00:00.000Z",
            event: {
              type: "effect_receipt",
              idempotencyKey: "run-child:call-write",
              tool: "write",
              status: "not_started",
              agent: "main",
              callId: "call-write",
              turnId: "turn-write",
              ...(binding ? { binding } : {}),
            },
          },
        ],
        artifacts: [],
        checkpoints: [
          {
            version: 1,
            checkpointId: "checkpoint-incomplete-not-started",
            runId: "run-child",
            toolCallId: "call-write",
            idempotencyKey: "run-child:call-write",
            timestamp: "2026-08-29T00:00:00.000Z",
            tool: "write",
            reversible: true,
            snapshotFile: "checkpoint-incomplete-not-started.json",
          },
        ],
      }) as RunResult;
    runtime.waitForQuiescence = async () => true;
    const adapter = createCoreMindChildRunAdapter({ createRuntime: async () => runtime });

    await expect(adapter.execute(executionInput())).rejects.toMatchObject({
      code: "checkpoint_failed",
    });
  });
});

function executionInput(): ChildRunExecutionInput {
  const model = {
    providerId: "probe",
    model: "probe-model",
    providerConfigFingerprint: "sha256:test-provider-config",
    agentPromptFingerprint: "sha256:test-agent-prompt",
    agentDelegationFingerprint: "sha256:test-agent-delegation",
  };
  const workspace = { canonicalRoot: "C:/test-workspace", lease: "shared_canonical" as const };
  const permissions = {
    mode: "ask" as const,
    workspaceOnly: true,
    network: "ask" as const,
    tools: [],
    paths: [],
    credentials: [],
  };
  const allocation = {
    tokens: 10,
    toolCalls: 0,
    costUsd: 1,
    wallTimeMs: 1_000,
    steps: 1,
    descendants: 0,
  };
  const request = {
    delegationId: "delegation-child-adapter",
    parentTurnId: "turn-parent",
    parentStepId: "step-parent",
    agentName: "main",
    task: "执行子任务",
    model,
    workspace,
    lifecyclePolicy: {
      join: "structured" as const,
      cancel: "propagate_parent" as const,
      orphan: "audit_pause" as const,
      detach: "forbidden" as const,
    },
    context: { workingSetFingerprint: "sha256:child-adapter", references: [] },
    allocation,
    permissions,
    environment: {},
  };
  return {
    parentRunId: "run-parent",
    childRunId: "run-child",
    delegationId: request.delegationId,
    inputFingerprint: childRunInputFingerprint(request),
    request,
    inheritedPolicy: {
      depth: 1,
      budget: allocation,
      permissions,
      environment: {},
      model,
      workspace,
      protectedContextReferences: [],
      maxDepth: 3,
      maxActiveChildren: 1,
      maxDescendants: 0,
    },
    signal: new AbortController().signal,
  };
}

async function createRegisteredRuntime(): Promise<CoreMindRuntime> {
  const configDir = mkdtempSync(path.join(tmpdir(), "coremind-child-adapter-runtime-"));
  temporaryDirectories.push(configDir);
  return CoreMindRuntime.create({
    config: {
      schemaVersion: 2,
      name: "Child Adapter 测试",
      provider: {
        id: "probe",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "probe-model",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      agents: { main: {} },
    },
    configDir,
    cwd: configDir,
  });
}

async function executeRuntimeTrace(
  trace: RunResult["trace"],
  extraResult: Readonly<Record<string, unknown>> = {},
) {
  const runtime = await createRegisteredRuntime();
  runtime.verifyChildRunAuthority = async () => undefined;
  runtime.run = async () =>
    ({
      runId: "run-child",
      outcome: { status: "failed", finishReason: "error" },
      artifacts: [],
      checkpoints: [],
      snapshot: { artifacts: [] },
      ...extraResult,
      trace,
    }) as RunResult;
  runtime.waitForQuiescence = async () => true;
  return createCoreMindChildRunAdapter({ createRuntime: async () => runtime }).execute(
    executionInput(),
  );
}

function descendantChildRuns(
  recovery: NonNullable<NonNullable<RunResult["childRuns"]>["nodes"][number]["result"]>["recovery"],
): NonNullable<RunResult["childRuns"]> {
  return {
    nodes: [
      {
        status: "joined",
        childRunId: "run-grandchild",
        result: {
          outcome: { status: "succeeded", finishReason: "completed" },
          evidence: [],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: [],
          recovery,
        },
      } as NonNullable<RunResult["childRuns"]>["nodes"][number],
    ],
    activeDescendants: 0,
    unhandledDescendants: 0,
    quiescent: true,
  };
}

function traceEntry(
  eventId: string,
  sequence: number,
  event: RunResult["trace"][number]["event"],
): RunResult["trace"][number] {
  return {
    eventId,
    runId: "run-child",
    sequence,
    timestamp: "2026-08-29T00:00:00.000Z",
    event,
  };
}

function safeToolTrace(
  receiptStatus?: "not_started" | "started" | "committed" | "unknown",
  bound = true,
): RunResult["trace"] {
  const args = { query: "status" };
  const capability = {
    tool: "inspect",
    effect: "none" as const,
    replay: "safe" as const,
    concurrency: "parallel" as const,
    checkpoint: "none" as const,
    durability: "ordinary" as const,
    source: "registered" as const,
    resolution: "resolved" as const,
    issues: [],
  };
  const trace: RunResult["trace"] = [
    traceEntry("event-tool-call", 1, {
      type: "tool_call",
      agent: "main",
      tool: "inspect",
      args,
      callId: "call-inspect",
      idempotencyKey: "run-child:call-inspect",
      turnId: "turn-inspect",
    }),
    traceEntry("event-capability", 2, {
      type: "capability_resolved",
      agent: "main",
      tool: "inspect",
      callId: "call-inspect",
      capability,
      recoveryDisposition: "replay_safe",
    }),
  ];
  if (receiptStatus === undefined) return trace;
  return [
    ...trace,
    traceEntry(`event-receipt-${receiptStatus}`, 3, {
      type: "effect_receipt",
      idempotencyKey: "run-child:call-inspect",
      tool: "inspect",
      status: receiptStatus,
      agent: "main",
      callId: "call-inspect",
      turnId: "turn-inspect",
      ...(bound
        ? {
            binding: createEffectReceiptBinding({
              runId: "run-child",
              turnId: "turn-inspect",
              agent: "main",
              callId: "call-inspect",
              tool: "inspect",
              args,
              capability,
            }),
          }
        : {}),
    }),
  ];
}

function effectfulToolTrace(
  replay: "idempotent" | "unsafe" | "unknown",
  recoveryDisposition: "requires_proof" | "forbidden" | "requires_human",
  receiptStatuses: readonly ("not_started" | "started" | "committed" | "unknown")[],
): RunResult["trace"] {
  const args = { target: "external-resource" };
  const capability = {
    tool: "effectful",
    effect: "external" as const,
    replay,
    concurrency: "run_serial" as const,
    checkpoint: "unsupported" as const,
    durability: "critical" as const,
    source: "registered" as const,
    resolution: "resolved" as const,
    issues: [],
  };
  const binding = createEffectReceiptBinding({
    runId: "run-child",
    turnId: "turn-effectful",
    agent: "main",
    callId: "call-effectful",
    tool: "effectful",
    args,
    capability,
  });
  return [
    traceEntry("event-tool-call", 1, {
      type: "tool_call",
      agent: "main",
      tool: "effectful",
      args,
      callId: "call-effectful",
      idempotencyKey: "run-child:call-effectful",
      turnId: "turn-effectful",
    }),
    traceEntry("event-capability", 2, {
      type: "capability_resolved",
      agent: "main",
      tool: "effectful",
      callId: "call-effectful",
      capability,
      recoveryDisposition,
    }),
    ...receiptStatuses.map((status, index) =>
      traceEntry(`event-receipt-${status}`, index + 3, {
        type: "effect_receipt",
        idempotencyKey: "run-child:call-effectful",
        tool: "effectful",
        status,
        agent: "main",
        callId: "call-effectful",
        turnId: "turn-effectful",
        binding,
      }),
    ),
  ];
}
