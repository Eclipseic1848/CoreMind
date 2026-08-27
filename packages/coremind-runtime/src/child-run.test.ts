import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHILD_RUN_LIMIT_DEFAULTS,
  ChildRunCoordinator,
  type ChildRunDelegationRequest,
  type ChildRunExecutionAdapter,
  type ChildRunPolicySnapshot,
  foldChildRunLifecycleStatus,
  isChildRunFact,
} from "./child-run.js";
import { ProjectionEngine } from "./projection.js";
import {
  FileRunStore,
  MemoryRunStore,
  RunStateJournal,
  type RunStore,
  type RunStoreDurability,
} from "./run-state.js";

const TEST_MODEL = { providerId: "test-provider", model: "test-model" };
const TEST_WORKSPACE = {
  canonicalRoot: "C:/test-workspace",
  lease: "shared_canonical" as const,
};
const TEST_PARENT_POLICY_AUTHORITY = {
  model: TEST_MODEL,
  workspace: TEST_WORKSPACE,
  protectedContextReferences: [] as string[],
};
const TEST_DELEGATION_AUTHORITY = {
  model: TEST_MODEL,
  workspace: TEST_WORKSPACE,
  lifecyclePolicy: {
    join: "structured" as const,
    cancel: "propagate_parent" as const,
    orphan: "audit_pause" as const,
    detach: "forbidden" as const,
  },
};

describe("ChildRunCoordinator", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("相同 DelegationId 与输入在重启后幂等返回同一已 join Child Run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const parentRunId = "run-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "parent-config" });
    const request = {
      delegationId: "delegation-review",
      parentTurnId: "turn-parent-1",
      parentStepId: "step-parent-1",
      agentName: "reviewer",
      task: "检查当前差异并返回结构化证据",
      ...TEST_DELEGATION_AUTHORITY,
      context: {
        workingSetFingerprint: "sha256:context-one",
        references: ["fact:parent:12", "artifact:diff-1"],
      },
      allocation: {
        tokens: 2_000,
        toolCalls: 8,
        costUsd: 1,
        wallTimeMs: 60_000,
        steps: 12,
        descendants: 2,
      },
      permissions: {
        mode: "assisted" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read", "search"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
    };
    const parentPolicy = {
      depth: 0,
      ...TEST_PARENT_POLICY_AUTHORITY,
      budget: {
        tokens: 10_000,
        toolCalls: 30,
        costUsd: 5,
        wallTimeMs: 300_000,
        steps: 50,
        descendants: 8,
      },
      permissions: {
        mode: "assisted" as const,
        workspaceOnly: true,
        network: "ask" as const,
        tools: ["read", "search", "write"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "controlled" as const },
      maxDepth: 3,
      maxActiveChildren: 4,
    };
    const firstAdapter: ChildRunExecutionAdapter = {
      execute: async ({ childRunId }) => ({
        outcome: { status: "succeeded", finishReason: "reviewed" },
        evidence: [`evidence:${childRunId}:first`],
        artifacts: [],
        workspaceChanges: [],
        unresolvedRisks: [],
      }),
    };
    const first = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy,
      adapter: firstAdapter,
      createChildRunId: () => "run-child-1",
      now: () => "2026-08-27T00:00:00.000Z",
    });

    const firstHandle = await first.delegate(request);
    const firstResult = await firstHandle.join();
    expect(firstResult.evidence).toEqual(["evidence:run-child-1:first"]);

    const persisted = await store.read(parentRunId);
    const resumedJournal = new RunStateJournal(parentRunId, store, persisted.length);
    const restarted = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: resumedJournal,
      runStore: store,
      parentPolicy,
      adapter: {
        execute: async () => ({
          outcome: { status: "failed", finishReason: "不应重新执行" },
          evidence: ["second-execution"],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: ["duplicate-effect"],
        }),
      },
      createChildRunId: () => "run-child-2",
      now: () => "2026-08-27T00:01:00.000Z",
    });

    const duplicateHandle = await restarted.delegate(request);
    expect(duplicateHandle.childRunId).toBe("run-child-1");
    expect(await duplicateHandle.join()).toEqual(firstResult);
    await expect(
      restarted.delegate({ ...request, task: "篡改后的不同任务" }),
    ).rejects.toMatchObject({ code: "delegation_conflict" });

    const projection = ProjectionEngine.project(await store.read(parentRunId));
    expect(projection.childRuns).toEqual({
      nodes: [
        expect.objectContaining({
          parentRunId,
          childRunId: "run-child-1",
          delegationId: "delegation-review",
          status: "joined",
          outcome: { status: "succeeded", finishReason: "reviewed" },
        }),
      ],
      activeDescendants: 0,
      unhandledDescendants: 0,
      quiescent: true,
    });
    await resumedJournal.appendFact(
      "delegation",
      {
        type: "child_running",
        parentRunId,
        childRunId: "run-child-1",
        delegationId: request.delegationId,
        inputFingerprint: duplicateHandle.inputFingerprint,
        recordedAt: "2026-08-27T00:02:00.000Z",
      },
      { durability: "ordinary" },
    );
    const corrupted = await store.read(parentRunId);
    expect(() => ProjectionEngine.project(corrupted)).toThrow("joined 后");
  });

  it("在持久化委派前拒绝放宽父级深度、预算、权限或执行环境", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-policy-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const parentRunId = "run-parent-policy";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "parent-policy" });
    const baseRequest = {
      delegationId: "delegation-policy",
      parentTurnId: "turn-parent-1",
      parentStepId: "step-parent-1",
      agentName: "worker",
      task: "执行受限任务",
      ...TEST_DELEGATION_AUTHORITY,
      context: {
        workingSetFingerprint: "sha256:context-policy",
        references: ["fact:parent:20"],
      },
      allocation: {
        tokens: 1_000,
        toolCalls: 4,
        costUsd: 0.5,
        wallTimeMs: 30_000,
        steps: 6,
        descendants: 1,
      },
      permissions: {
        mode: "ask" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
    };
    const parentPolicy = {
      depth: 1,
      ...TEST_PARENT_POLICY_AUTHORITY,
      budget: {
        tokens: 2_000,
        toolCalls: 8,
        costUsd: 1,
        wallTimeMs: 60_000,
        steps: 12,
        descendants: 2,
      },
      permissions: {
        mode: "assisted" as const,
        workspaceOnly: true,
        network: "ask" as const,
        tools: ["read", "search"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
      maxDepth: 3,
      maxActiveChildren: 2,
    };
    let executions = 0;

    const invalidCases = [
      {
        name: "深度",
        policy: { ...parentPolicy, depth: 3 },
        request: baseRequest,
      },
      {
        name: "预算",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          allocation: { ...baseRequest.allocation, tokens: 2_001 },
        },
      },
      {
        name: "权限模式",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          permissions: { ...baseRequest.permissions, mode: "full" as const },
        },
      },
      {
        name: "工作区边界",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          permissions: { ...baseRequest.permissions, workspaceOnly: false },
        },
      },
      {
        name: "网络权限",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          permissions: { ...baseRequest.permissions, network: "allow" as const },
        },
      },
      {
        name: "工具集合",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          permissions: { ...baseRequest.permissions, tools: ["read", "write"] },
        },
      },
      {
        name: "路径集合",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          permissions: { ...baseRequest.permissions, paths: [".", "../outside"] },
        },
      },
      {
        name: "凭据集合",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          permissions: { ...baseRequest.permissions, credentials: ["provider-key"] },
        },
      },
      {
        name: "执行环境",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          environment: { networkEgress: "controlled" as const },
        },
      },
      {
        name: "模型",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          model: { providerId: "other-provider", model: "other-model" },
        },
      },
      {
        name: "Workspace",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          workspace: { canonicalRoot: "C:/other-workspace", lease: "shared_canonical" as const },
        },
      },
      {
        name: "受保护上下文",
        policy: { ...parentPolicy, protectedContextReferences: ["fact:required"] },
        request: baseRequest,
      },
    ];

    for (const testCase of invalidCases) {
      const coordinator = await ChildRunCoordinator.open({
        parentRunId,
        parentJournal: journal,
        runStore: store,
        parentPolicy: testCase.policy,
        adapter: {
          execute: async () => {
            executions += 1;
            throw new Error("不应执行");
          },
        },
        createChildRunId: () => `run-child-${testCase.name}`,
      });
      await expect(coordinator.delegate(testCase.request)).rejects.toMatchObject({
        code: "child_run_policy_escalation",
      });
    }

    expect(executions).toBe(0);
    expect(
      (await store.read(parentRunId)).filter((record) => record.kind === "delegation"),
    ).toEqual([]);
  });

  it("限制活动子级并发，父取消传播后等待终态与 join 才静止", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-cancel-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const parentRunId = "run-parent-cancel";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "parent-cancel" });
    let childSignal: AbortSignal | undefined;
    let markChildStarted: (() => void) | undefined;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: {
        depth: 0,
        ...TEST_PARENT_POLICY_AUTHORITY,
        budget: {
          tokens: 4_000,
          toolCalls: 10,
          costUsd: 2,
          wallTimeMs: 120_000,
          steps: 20,
          descendants: 4,
        },
        permissions: {
          mode: "assisted",
          workspaceOnly: true,
          network: "deny",
          tools: ["read"],
          paths: ["."],
          credentials: [],
        },
        environment: { networkEgress: "denied" },
        maxDepth: 3,
        maxActiveChildren: 1,
      },
      adapter: {
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            childSignal = signal;
            markChildStarted?.();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      createChildRunId: (() => {
        let id = 0;
        return () => `run-child-cancel-${++id}`;
      })(),
      now: () => "2026-08-27T00:02:00.000Z",
    });
    const request = {
      delegationId: "delegation-cancel-1",
      parentTurnId: "turn-parent-1",
      parentStepId: "step-parent-1",
      agentName: "worker",
      task: "等待父级取消",
      ...TEST_DELEGATION_AUTHORITY,
      context: { workingSetFingerprint: "sha256:cancel", references: [] },
      allocation: {
        tokens: 1_000,
        toolCalls: 2,
        costUsd: 0.5,
        wallTimeMs: 30_000,
        steps: 5,
        descendants: 1,
      },
      permissions: {
        mode: "ask" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
    };

    const handle = await coordinator.delegate(request);
    await childStarted;
    await expect(
      coordinator.delegate({ ...request, delegationId: "delegation-cancel-2" }),
    ).rejects.toMatchObject({ code: "child_run_concurrency_limit" });
    expect(coordinator.isQuiescent()).toBe(false);

    await coordinator.cancelAll("父 Run 已取消");
    expect(childSignal?.aborted).toBe(true);
    expect(coordinator.isQuiescent()).toBe(true);
    expect(await handle.join()).toMatchObject({
      outcome: { status: "aborted", finishReason: "parent_cancelled" },
    });
    expect(coordinator.isQuiescent()).toBe(true);
  });

  it("子取消不传播给父级，join timeout 会取消并等待子级清理", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-timeout-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const parentRunId = "run-parent-timeout";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "parent-timeout" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: {
        depth: 0,
        ...TEST_PARENT_POLICY_AUTHORITY,
        budget: {
          tokens: 2_000,
          toolCalls: 4,
          costUsd: 2,
          wallTimeMs: 2_000,
          steps: 4,
          descendants: 2,
        },
        permissions: {
          mode: "ask",
          workspaceOnly: true,
          network: "deny",
          tools: ["read"],
          paths: ["."],
          credentials: [],
        },
        environment: { networkEgress: "denied" },
        maxDepth: 3,
        maxActiveChildren: 2,
      },
      adapter: {
        execute: ({ signal }) =>
          new Promise((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      createChildRunId: (() => {
        let id = 0;
        return () => `run-child-timeout-${++id}`;
      })(),
    });
    const request = {
      delegationId: "delegation-child-cancel",
      parentTurnId: "turn-parent",
      parentStepId: "step-parent",
      agentName: "worker",
      task: "等待子级取消",
      ...TEST_DELEGATION_AUTHORITY,
      context: { workingSetFingerprint: "sha256:child-cancel", references: [] },
      allocation: {
        tokens: 500,
        toolCalls: 1,
        costUsd: 0.5,
        wallTimeMs: 500,
        steps: 1,
        descendants: 0,
      },
      permissions: {
        mode: "ask" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
    };

    const cancelled = await coordinator.delegate(request);
    await cancelled.cancel("用户只取消子级");
    expect(await cancelled.join()).toMatchObject({
      outcome: { status: "aborted", finishReason: "child_cancelled" },
    });

    const timedOut = await coordinator.delegate({
      ...request,
      delegationId: "delegation-join-timeout",
      task: "等待 join timeout",
    });
    expect(await timedOut.join({ timeoutMs: 1 })).toMatchObject({
      outcome: { status: "timeout", finishReason: "child_join_timeout" },
    });
    expect(coordinator.isQuiescent()).toBe(true);
  });

  it("恢复时把无法确认所有权的运行中子级标记为 orphan，且不自动重启", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-orphan-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const parentRunId = "run-parent-orphan";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "parent-orphan" });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const parentPolicy = {
      depth: 0,
      ...TEST_PARENT_POLICY_AUTHORITY,
      budget: {
        tokens: 2_000,
        toolCalls: 8,
        costUsd: 1,
        wallTimeMs: 60_000,
        steps: 12,
        descendants: 2,
      },
      permissions: {
        mode: "assisted" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
      maxDepth: 3,
      maxActiveChildren: 2,
    };
    const request = {
      delegationId: "delegation-orphan",
      parentTurnId: "turn-parent-1",
      parentStepId: "step-parent-1",
      agentName: "worker",
      task: "模拟 Worker 崩溃",
      ...TEST_DELEGATION_AUTHORITY,
      context: { workingSetFingerprint: "sha256:orphan", references: [] },
      allocation: {
        tokens: 1_000,
        toolCalls: 2,
        costUsd: 0.5,
        wallTimeMs: 30_000,
        steps: 5,
        descendants: 1,
      },
      permissions: parentPolicy.permissions,
      environment: parentPolicy.environment,
    };
    const original = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy,
      adapter: {
        execute: () =>
          new Promise(() => {
            markStarted?.();
          }),
      },
      createChildRunId: () => "run-child-orphan",
    });
    await original.delegate(request);
    await started;

    const persisted = await store.read(parentRunId);
    let restartedExecutions = 0;
    const resumed = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: new RunStateJournal(parentRunId, store, persisted.length),
      runStore: store,
      parentPolicy,
      adapter: {
        execute: async () => {
          restartedExecutions += 1;
          throw new Error("不得自动重启 orphan Child Run");
        },
      },
      createChildRunId: () => "run-child-duplicate",
      now: () => "2026-08-27T00:03:00.000Z",
    });

    const orphanHandle = await resumed.delegate(request);
    expect(restartedExecutions).toBe(0);
    expect(await orphanHandle.join()).toMatchObject({
      outcome: {
        status: "paused",
        finishReason: "child_run_orphaned",
        error: { code: "child_run_orphan_audit_required" },
      },
    });
    expect(resumed.isQuiescent()).toBe(true);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [expect.objectContaining({ childRunId: "run-child-orphan", status: "joined" })],
      activeDescendants: 0,
      unhandledDescendants: 0,
      quiescent: true,
    });
  });

  it("兄弟子级共享父级剩余预算，并向 Adapter 传递实际划拨后的子级策略", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-budget-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const parentRunId = "run-parent-budget";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "parent-budget" });
    const parentPolicy = {
      depth: 0,
      ...TEST_PARENT_POLICY_AUTHORITY,
      budget: {
        tokens: 1_500,
        toolCalls: 6,
        costUsd: 1.5,
        wallTimeMs: 90_000,
        steps: 15,
        descendants: 3,
      },
      permissions: {
        mode: "assisted" as const,
        workspaceOnly: true,
        network: "ask" as const,
        tools: ["read", "search"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "controlled" as const },
      maxDepth: 3,
      maxActiveChildren: 2,
    };
    const inheritedPolicies: (typeof parentPolicy)[] = [];
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy,
      adapter: {
        execute: async ({ inheritedPolicy }) => {
          inheritedPolicies.push(inheritedPolicy);
          return {
            outcome: { status: "succeeded", finishReason: "done" },
            evidence: [],
            artifacts: [],
            workspaceChanges: [],
            unresolvedRisks: [],
          };
        },
      },
      createChildRunId: (() => {
        let id = 0;
        return () => `run-child-budget-${++id}`;
      })(),
    });
    const firstRequest = {
      delegationId: "delegation-budget-1",
      parentTurnId: "turn-parent-1",
      parentStepId: "step-parent-1",
      agentName: "worker",
      task: "第一次划拨",
      ...TEST_DELEGATION_AUTHORITY,
      context: { workingSetFingerprint: "sha256:budget-1", references: [] },
      allocation: {
        tokens: 1_000,
        toolCalls: 3,
        costUsd: 1,
        wallTimeMs: 30_000,
        steps: 8,
        descendants: 1,
      },
      permissions: {
        mode: "ask" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
    };
    await (await coordinator.delegate(firstRequest)).join();
    expect(inheritedPolicies).toEqual([
      {
        depth: 1,
        ...TEST_PARENT_POLICY_AUTHORITY,
        budget: firstRequest.allocation,
        permissions: firstRequest.permissions,
        environment: firstRequest.environment,
        maxDepth: 3,
        maxActiveChildren: 2,
        maxDescendants: 1,
      },
    ]);

    await expect(
      coordinator.delegate({
        ...firstRequest,
        delegationId: "delegation-budget-2",
        task: "第二次超分",
        allocation: {
          tokens: 501,
          toolCalls: 1,
          costUsd: 0.1,
          wallTimeMs: 1_000,
          steps: 1,
          descendants: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
  });

  it("从 RunStore 递归重建三层 Child Run tree", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-run-tree-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const policy = {
      depth: 0,
      ...TEST_PARENT_POLICY_AUTHORITY,
      budget: {
        tokens: 4_000,
        toolCalls: 12,
        costUsd: 2,
        wallTimeMs: 120_000,
        steps: 24,
        descendants: 4,
      },
      permissions: {
        mode: "ask" as const,
        workspaceOnly: true,
        network: "deny" as const,
        tools: ["read"],
        paths: ["."],
        credentials: [],
      },
      environment: { networkEgress: "denied" as const },
      maxDepth: 3,
      maxActiveChildren: 2,
    };
    const result = {
      outcome: { status: "succeeded" as const, finishReason: "done" },
      evidence: [],
      artifacts: [],
      workspaceChanges: [],
      unresolvedRisks: [],
    };
    const parentJournal = new RunStateJournal("run-tree-parent", store);
    await parentJournal.start({ configFingerprint: "tree-parent" });
    let childPolicy: typeof policy | undefined;
    const parent = await ChildRunCoordinator.open({
      parentRunId: "run-tree-parent",
      parentJournal,
      runStore: store,
      parentPolicy: policy,
      adapter: {
        execute: async ({ inheritedPolicy }) => {
          childPolicy = inheritedPolicy;
          return result;
        },
      },
      createChildRunId: () => "run-tree-child",
    });
    await (
      await parent.delegate({
        delegationId: "delegation-tree-child",
        parentTurnId: "turn-parent",
        parentStepId: "step-parent",
        agentName: "child",
        task: "创建子级",
        ...TEST_DELEGATION_AUTHORITY,
        context: { workingSetFingerprint: "sha256:tree-child", references: [] },
        allocation: {
          tokens: 2_000,
          toolCalls: 6,
          costUsd: 1,
          wallTimeMs: 60_000,
          steps: 12,
          descendants: 2,
        },
        permissions: policy.permissions,
        environment: policy.environment,
      })
    ).join();
    const childJournal = new RunStateJournal("run-tree-child", store);
    await childJournal.start({ configFingerprint: "tree-child" });
    childJournal.event({
      eventId: "event-child-lease",
      runId: "run-tree-child",
      sequence: 1,
      timestamp: "2026-08-27T00:00:00.000Z",
      event: {
        type: "workspace_lease",
        status: "acquired",
        canonicalRoot: TEST_WORKSPACE.canonicalRoot,
        lane: "workspace_exclusive",
        owner: { runId: "run-tree-child", callId: "call-child-write", pid: 123 },
        agent: "child",
        callId: "call-child-write",
      },
    });
    childJournal.event({
      eventId: "event-child-lease-released",
      runId: "run-tree-child",
      sequence: 2,
      timestamp: "2026-08-27T00:00:01.000Z",
      event: {
        type: "workspace_lease",
        status: "released",
        canonicalRoot: TEST_WORKSPACE.canonicalRoot,
        lane: "workspace_exclusive",
        owner: { runId: "run-tree-child", callId: "call-child-write", pid: 123 },
        agent: "child",
        callId: "call-child-write",
      },
    });
    await childJournal.flush("critical");
    const child = await ChildRunCoordinator.open({
      parentRunId: "run-tree-child",
      parentJournal: childJournal,
      runStore: store,
      parentPolicy: childPolicy!,
      adapter: { execute: async () => result },
      createChildRunId: () => "run-tree-grandchild",
    });
    await (
      await child.delegate({
        delegationId: "delegation-tree-grandchild",
        parentTurnId: "turn-child",
        parentStepId: "step-child",
        agentName: "grandchild",
        task: "创建孙级",
        ...TEST_DELEGATION_AUTHORITY,
        context: { workingSetFingerprint: "sha256:tree-grandchild", references: [] },
        allocation: {
          tokens: 500,
          toolCalls: 2,
          costUsd: 0.2,
          wallTimeMs: 10_000,
          steps: 3,
          descendants: 0,
        },
        permissions: policy.permissions,
        environment: policy.environment,
      })
    ).join();

    expect((await ProjectionEngine.projectTree(store, "run-tree-parent")).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          parentRunId: "run-tree-parent",
          childRunId: "run-tree-child",
          workspaceLeases: [
            expect.objectContaining({
              status: "released",
              owner: { runId: "run-tree-child", callId: "call-child-write", pid: 123 },
            }),
          ],
        }),
        expect.objectContaining({
          parentRunId: "run-tree-child",
          childRunId: "run-tree-grandchild",
        }),
      ],
      activeDescendants: 0,
      unhandledDescendants: 0,
      quiescent: true,
    });
  });

  it("1,000 个固定调度种子保持身份幂等、故障收敛和有限默认值", async () => {
    expect(CHILD_RUN_LIMIT_DEFAULTS).toEqual({
      maxDepth: 3,
      maxActiveChildren: 4,
      maxDescendants: 32,
    });
    const store = durableMemoryRunStore();
    for (let seed = 0; seed < 1_000; seed += 1) {
      const parentRunId = `run-seed-${seed}`;
      const journal = new RunStateJournal(parentRunId, store);
      await journal.start({ configFingerprint: `seed-${seed}` });
      const childCount = 1 + (seed % 3);
      const coordinator = await ChildRunCoordinator.open({
        parentRunId,
        parentJournal: journal,
        runStore: store,
        parentPolicy: {
          depth: 0,
          ...TEST_PARENT_POLICY_AUTHORITY,
          budget: {
            tokens: childCount * 10,
            toolCalls: childCount,
            costUsd: childCount,
            wallTimeMs: childCount * 100,
            steps: childCount,
            descendants: CHILD_RUN_LIMIT_DEFAULTS.maxDescendants,
          },
          permissions: {
            mode: "ask",
            workspaceOnly: true,
            network: "deny",
            tools: ["read"],
            paths: ["."],
            credentials: [],
          },
          environment: { networkEgress: "denied" },
          maxDepth: CHILD_RUN_LIMIT_DEFAULTS.maxDepth,
          maxActiveChildren: CHILD_RUN_LIMIT_DEFAULTS.maxActiveChildren,
        },
        adapter: {
          execute: async ({ delegationId, signal }) => {
            const child = Number(delegationId.at(-1));
            await yieldMicrotasks((seed + child) % 4);
            if (signal.aborted) throw signal.reason;
            if ((seed + child) % 17 === 0) {
              throw new Error(`seeded-failure-${seed}`);
            }
            return {
              outcome: { status: "succeeded", finishReason: "seeded-success" },
              evidence: [`seed:${seed}`],
              artifacts: [],
              workspaceChanges: [],
              unresolvedRisks: [],
            };
          },
        },
        createChildRunId: (() => {
          let child = 0;
          return () => `${parentRunId}:child:${++child}`;
        })(),
      });
      const requests = Array.from({ length: childCount }, (_, child) => ({
        delegationId: `delegation-seed-${child}`,
        parentTurnId: "turn-seed",
        parentStepId: `step-${child}`,
        agentName: "seed-worker",
        task: `seed-task-${seed}-${child}`,
        ...TEST_DELEGATION_AUTHORITY,
        context: { workingSetFingerprint: `sha256:${seed}:${child}`, references: [] },
        allocation: {
          tokens: 10,
          toolCalls: 1,
          costUsd: 1,
          wallTimeMs: 100,
          steps: 1,
          descendants: 0,
        },
        permissions: {
          mode: "ask" as const,
          workspaceOnly: true,
          network: "deny" as const,
          tools: ["read"],
          paths: ["."],
          credentials: [],
        },
        environment: { networkEgress: "denied" as const },
      }));
      const pairs = await Promise.all(
        requests.map(async (request) =>
          Promise.all([coordinator.delegate(request), coordinator.delegate(request)]),
        ),
      );
      const childIds = pairs.map(([handle]) => handle.childRunId);
      await Promise.all(
        pairs.map(async ([first, duplicate], child) => {
          expect(duplicate.childRunId).toBe(first.childRunId);
          if ((seed + child) % 11 === 0) await duplicate.cancel("seeded-cancel");
          const [firstResult, duplicateResult] = await Promise.all([
            first.join(),
            duplicate.join(),
          ]);
          expect(duplicateResult).toEqual(firstResult);
        }),
      );
      expect(new Set(childIds).size).toBe(childCount);
      expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
        activeDescendants: 0,
        unhandledDescendants: 0,
        quiescent: true,
      });
    }
  }, 30_000);

  it("并发相同委派等待同一持久初始化，不误判为 orphan", async () => {
    const baseStore = durableMemoryRunStore();
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let delayDelegation = false;
    const store: RunStore = {
      ...baseStore,
      commit: async (record, requested) => {
        if (delayDelegation && record.kind === "delegation") await blocked;
        return baseStore.commit!(record, requested);
      },
    };
    const journal = new RunStateJournal("run-concurrent", store);
    await journal.start({ configFingerprint: "concurrent" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-concurrent",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: { execute: async () => successfulChildResult() },
      createChildRunId: () => "run-concurrent-child",
    });
    const request = testDelegationRequest("delegation-concurrent");

    delayDelegation = true;
    const first = coordinator.delegate(request);
    const duplicate = await coordinator.delegate(request);
    const duplicateJoin = duplicate.join();
    unblock?.();

    const firstHandle = await first;
    expect(duplicate.childRunId).toBe(firstHandle.childRunId);
    await expect(duplicateJoin).resolves.toEqual(successfulChildResult());
    await expect(firstHandle.join()).resolves.toEqual(successfulChildResult());
  });

  it("把 paused 结果持久化为 child_paused Fact", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-paused", store);
    await journal.start({ configFingerprint: "paused" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-paused",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          ...successfulChildResult(),
          outcome: { status: "paused", finishReason: "needs_review" },
        }),
      },
      createChildRunId: () => "run-paused-child",
    });

    await (await coordinator.delegate(testDelegationRequest("delegation-paused"))).join();
    expect((await store.read("run-paused")).map((record) => record.payload)).toContainEqual(
      expect.objectContaining({ type: "child_paused" }),
    );
  });

  it("拒绝无限或超过默认上限的父级 Child Run policy", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-invalid-limits", store);
    await journal.start({ configFingerprint: "invalid-limits" });

    await expect(
      ChildRunCoordinator.open({
        parentRunId: "run-invalid-limits",
        parentJournal: journal,
        runStore: store,
        parentPolicy: { ...testParentPolicy(), maxDepth: Number.POSITIVE_INFINITY },
        adapter: { execute: async () => successfulChildResult() },
        createChildRunId: () => "never",
      }),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    await expect(
      ChildRunCoordinator.open({
        parentRunId: "run-invalid-limits",
        parentJournal: journal,
        runStore: store,
        parentPolicy: {
          ...testParentPolicy(),
          budget: { ...testParentPolicy().budget, descendants: 33 },
        },
        adapter: { execute: async () => successfulChildResult() },
        createChildRunId: () => "never",
      }),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
  });

  it("省略可选上限时仍执行默认四个活动子级限制", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-default-limit", store);
    await journal.start({ configFingerprint: "default-limit" });
    const pending = new Promise<ReturnType<typeof successfulChildResult>>(() => undefined);
    const policy = testParentPolicy();
    delete policy.maxDepth;
    delete policy.maxActiveChildren;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-default-limit",
      parentJournal: journal,
      runStore: store,
      parentPolicy: policy,
      adapter: { execute: async () => pending },
      createChildRunId: (() => {
        let next = 0;
        return () => `run-default-child-${++next}`;
      })(),
    });
    for (let index = 0; index < CHILD_RUN_LIMIT_DEFAULTS.maxActiveChildren; index += 1) {
      await coordinator.delegate(testDelegationRequest(`delegation-default-${index}`));
    }
    await expect(
      coordinator.delegate(testDelegationRequest("delegation-default-overflow")),
    ).rejects.toMatchObject({ code: "child_run_concurrency_limit" });
  });

  it("join 超时后 Adapter 忽略取消时有界失败且不宣称静止", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-ignore-abort", store);
    await journal.start({ configFingerprint: "ignore-abort" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-ignore-abort",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: { execute: async () => new Promise(() => undefined) },
      createChildRunId: () => "run-ignore-abort-child",
      cancellationGraceMs: 5,
    });
    const handle = await coordinator.delegate(testDelegationRequest("delegation-ignore-abort"));
    await expect(handle.join({ timeoutMs: 1 })).rejects.toMatchObject({
      code: "child_run_not_quiescent",
    });
    expect(coordinator.isQuiescent()).toBe(false);
  });

  it("拒绝生命周期倒退和非法 Environment/Outcome Fact", () => {
    expect(() => foldChildRunLifecycleStatus("running", "child_created")).toThrowError(
      expect.objectContaining({ code: "run_state_corrupt" }),
    );
    expect(() => foldChildRunLifecycleStatus("recorded", "child_terminal")).toThrowError(
      expect.objectContaining({ code: "run_state_corrupt" }),
    );
    const identity = {
      parentRunId: "parent",
      childRunId: "child",
      delegationId: "delegation",
      inputFingerprint: "sha256:test",
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(
      isChildRunFact({
        ...identity,
        type: "child_terminal",
        result: {
          ...successfulChildResult(),
          outcome: { status: "invented", finishReason: "bad" },
        },
      }),
    ).toBe(false);
    const request = testDelegationRequest("delegation");
    const validDelegationFact = {
      ...identity,
      type: "delegation_recorded" as const,
      parentTurnId: request.parentTurnId,
      parentStepId: request.parentStepId,
      agentName: request.agentName,
      model: request.model,
      workspace: request.workspace,
      lifecyclePolicy: request.lifecyclePolicy,
      context: request.context,
      inheritedPolicy: {
        ...testParentPolicy(),
        depth: 1,
        budget: request.allocation,
        permissions: request.permissions,
        environment: request.environment,
        maxDescendants: request.allocation.descendants,
      },
      requestedAllocation: request.allocation,
      requestedPermissions: request.permissions,
      requestedEnvironment: request.environment,
    };
    expect(isChildRunFact(validDelegationFact)).toBe(true);
    expect(
      isChildRunFact({
        ...validDelegationFact,
        requestedEnvironment: { networkEgress: "open" },
      }),
    ).toBe(false);
    expect(
      isChildRunFact({
        ...validDelegationFact,
        inheritedPolicy: { ...validDelegationFact.inheritedPolicy, maxDescendants: "unbounded" },
      }),
    ).toBe(false);
  });

  it("父进程崩溃后从持久 Child Facts 审计 orphan，且不重复子副作用", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-process-crash-"));
    temporaryDirectories.push(directory);
    const storeDirectory = path.join(directory, "runs");
    const effectMarker = path.join(directory, "effects.log");
    const probe = path.resolve("scripts/child-run-crash-probe.mjs");
    const child = spawn(process.execPath, [probe, storeDirectory, effectMarker], {
      stdio: "pipe",
      windowsHide: true,
    });
    try {
      await waitForChildReady(child);
      child.kill();
      await waitForChildExit(child);

      const store = new FileRunStore(storeDirectory);
      const records = await store.read("run-crash-parent");
      const journal = new RunStateJournal("run-crash-parent", store, records.at(-1)?.sequence ?? 0);
      let reexecutions = 0;
      const coordinator = await ChildRunCoordinator.open({
        parentRunId: "run-crash-parent",
        parentJournal: journal,
        runStore: store,
        parentPolicy: testParentPolicy(),
        adapter: {
          execute: async () => {
            reexecutions += 1;
            return successfulChildResult();
          },
        },
        createChildRunId: () => "must-not-create",
      });
      const result = await (
        await coordinator.delegate(testDelegationRequest("delegation-crash"))
      ).join();

      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "child_run_orphaned",
      });
      expect(reexecutions).toBe(0);
      expect((await readFile(effectMarker, "utf8")).trim().split("\n")).toEqual(["child-effect"]);
      expect(coordinator.isQuiescent()).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 15_000);

  it("独立 Child Worker 未知崩溃暂停且不重复副作用", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-child-worker-crash-"));
    temporaryDirectories.push(directory);
    const effectMarker = path.join(directory, "effect.log");
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-child-worker-crash", store);
    await journal.start({ configFingerprint: "child-worker-crash" });
    let worker: ChildProcessWithoutNullStreams | undefined;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-child-worker-crash",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          const source = `require("node:fs").appendFileSync(${JSON.stringify(effectMarker)}, "effect\\n", "utf8"); process.exit(88);`;
          worker = spawn(process.execPath, ["-e", source], { stdio: "pipe", windowsHide: true });
          const exitCode = await waitForChildExitCode(worker);
          throw Object.assign(new Error(`Child Worker 崩溃：${exitCode}`), {
            code: "vendor_child_worker?token=child-secret",
          });
        },
      },
      createChildRunId: () => "run-crashed-worker",
    });

    const result = await (
      await coordinator.delegate(testDelegationRequest("delegation-worker-crash"))
    ).join();
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "unclassified_error",
      error: {
        code: "unclassified_error",
        audit: { originalCode: "vendor_child_worker?token=hidden" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("child-secret");
    expect(worker?.exitCode).toBe(88);
    expect((await readFile(effectMarker, "utf8")).trim().split("\n")).toEqual(["effect"]);
    expect(coordinator.isQuiescent()).toBe(true);
  });

  it("Child Adapter 返回的私有错误码在持久化前归一化并脱敏", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-child-private-error", store);
    await journal.start({ configFingerprint: "child-private-error" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-child-private-error",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          outcome: {
            status: "failed",
            finishReason: "vendor_private_error",
            error: {
              code: "vendor_private_error?token=child-secret",
              message: "Bearer child-secret",
            },
          },
          evidence: ["Bearer child-evidence-secret"],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: ["token=child-risk-secret"],
        }),
      },
      createChildRunId: () => "run-child-private-result",
    });

    const result = await (
      await coordinator.delegate(testDelegationRequest("delegation-private-result"))
    ).join();
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "unclassified_error",
      error: {
        code: "unclassified_error",
        audit: { originalCode: "vendor_private_error?token=hidden" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("child-secret");
    expect(JSON.stringify(result)).not.toContain("child-evidence-secret");
    expect(JSON.stringify(result)).not.toContain("child-risk-secret");
    expect(JSON.stringify(await store.read("run-child-private-error"))).not.toContain(
      "child-secret",
    );
  });

  it("Child Adapter 省略 error 时仍按未知 finishReason 收敛", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-child-private-finish", store);
    await journal.start({ configFingerprint: "child-private-finish" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-child-private-finish",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          outcome: {
            status: "failed",
            finishReason: "vendor_private_finish?api_key=child-secret",
          },
          evidence: [],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: [],
        }),
      },
      createChildRunId: () => "run-child-private-finish-result",
    });

    const result = await (
      await coordinator.delegate(testDelegationRequest("delegation-private-finish"))
    ).join();
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "unclassified_error",
      error: {
        code: "unclassified_error",
        audit: { originalCode: "vendor_private_finish?api_key=hidden" },
      },
    });
    expect(JSON.stringify(await store.read("run-child-private-finish"))).not.toContain(
      "child-secret",
    );
  });

  it("Child Adapter 正常返回父取消结果时保持取消语义", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-child-adapter-cancel", store);
    await journal.start({ configFingerprint: "child-adapter-cancel" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-child-adapter-cancel",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          outcome: { status: "aborted", finishReason: "parent_cancelled" },
          evidence: [],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: [],
        }),
      },
      createChildRunId: () => "run-child-adapter-cancelled",
    });

    const result = await (
      await coordinator.delegate(testDelegationRequest("delegation-adapter-cancel"))
    ).join();
    expect(result.outcome).toEqual({ status: "aborted", finishReason: "parent_cancelled" });
    expect(JSON.stringify(await store.read("run-child-adapter-cancel"))).toContain(
      '"finishReason":"parent_cancelled"',
    );
  });

  it("父 Cancel 会终止独立 Child Worker，join 后无孤儿进程", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-child-worker-cancel", store);
    await journal.start({ configFingerprint: "child-worker-cancel" });
    let worker: ChildProcessWithoutNullStreams | undefined;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-child-worker-cancel",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async ({ signal }) => {
          worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            stdio: "pipe",
            windowsHide: true,
          });
          if (signal.aborted) worker.kill();
          else signal.addEventListener("abort", () => worker?.kill(), { once: true });
          await waitForChildExit(worker);
          throw new Error("Child Worker 已取消");
        },
      },
      createChildRunId: () => "run-cancelled-worker",
    });
    await coordinator.delegate(testDelegationRequest("delegation-worker-cancel"));
    await coordinator.cancelAll("父 Run 取消");

    expect(worker?.killed).toBe(true);
    expect(coordinator.isQuiescent()).toBe(true);
  });
});

function testParentPolicy(): ChildRunPolicySnapshot {
  return {
    depth: 0,
    ...TEST_PARENT_POLICY_AUTHORITY,
    budget: {
      tokens: 100,
      toolCalls: 10,
      costUsd: 10,
      wallTimeMs: 10_000,
      steps: 10,
      descendants: 4,
    },
    permissions: {
      mode: "ask",
      workspaceOnly: true,
      network: "deny",
      tools: ["read"],
      paths: ["."],
      credentials: [],
    },
    environment: { networkEgress: "denied" },
    maxDepth: CHILD_RUN_LIMIT_DEFAULTS.maxDepth,
    maxActiveChildren: CHILD_RUN_LIMIT_DEFAULTS.maxActiveChildren,
  };
}

function testDelegationRequest(delegationId: string): ChildRunDelegationRequest {
  const policy = testParentPolicy();
  return {
    delegationId,
    parentTurnId: "turn-test",
    parentStepId: "step-test",
    agentName: "worker",
    task: "执行确定性测试子任务",
    ...TEST_DELEGATION_AUTHORITY,
    context: { workingSetFingerprint: `sha256:${delegationId}`, references: [] },
    allocation: {
      tokens: 10,
      toolCalls: 1,
      costUsd: 1,
      wallTimeMs: 1_000,
      steps: 1,
      descendants: 0,
    },
    permissions: policy.permissions,
    environment: policy.environment,
  };
}

function successfulChildResult() {
  return {
    outcome: { status: "succeeded" as const, finishReason: "done" },
    evidence: [] as string[],
    artifacts: [] as string[],
    workspaceChanges: [] as string[],
    unresolvedRisks: [] as string[],
  };
}

function waitForChildReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error("Child crash probe 等待超时")), 10_000);
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes("READY\n")) finish(resolve);
    };
    const onExit = (code: number | null) =>
      finish(reject, new Error(`Child crash probe 提前退出：${code}`));
    const finish = (settle: (value?: never) => void, value?: Error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      if (value) settle(value as never);
      else settle();
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function waitForChildExitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

async function yieldMicrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function durableMemoryRunStore(): RunStore {
  const memory = new MemoryRunStore();
  const acknowledgement = (requested: RunStoreDurability) => ({
    requested,
    achieved: requested,
    boundary: "process_crash" as const,
  });
  return {
    supportedDurability: ["ordinary", "critical"],
    durabilityBoundary: "process_crash",
    append: (record) => memory.append(record),
    commit: async (record, requested) => {
      await memory.append(record);
      return acknowledgement(requested);
    },
    barrier: async (_runId, requested) => acknowledgement(requested),
    read: (runId) => memory.read(runId),
  };
}
