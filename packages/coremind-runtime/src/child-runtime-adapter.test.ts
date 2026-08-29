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
