import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHILD_RUN_LIMIT_DEFAULTS,
  type ChildRunBudgetAllocation,
  ChildRunCoordinator,
  type ChildRunDelegationRequest,
  type ChildRunExecutionAdapter,
  type ChildRunPolicySnapshot,
  type ChildRunResult,
  childRunInputFingerprint,
  foldChildRunLifecycleStatus,
  isChildRunFact,
} from "./child-run.js";
import { CoreMindError } from "./errors.js";
import { ProjectionEngine } from "./projection.js";
import {
  FileRunStore,
  MemoryRunStore,
  RunStateJournal,
  type RunStore,
  type RunStoreDurability,
} from "./run-state.js";

const TEST_MODEL = {
  providerId: "test-provider",
  model: "test-model",
  providerConfigFingerprint: "sha256:test-provider-config",
  agentPromptFingerprint: "sha256:test-agent-prompt",
  agentDelegationFingerprint: "sha256:test-agent-delegation",
};
const TEST_WORKSPACE = {
  canonicalRoot: "C:/test-workspace",
  lease: "shared_canonical" as const,
};
const TEST_PARENT_POLICY_AUTHORITY = {
  model: TEST_MODEL,
  delegationModelRoutes: {
    __default__: {
      worker: TEST_MODEL,
      reviewer: TEST_MODEL,
      child: TEST_MODEL,
      grandchild: TEST_MODEL,
      "seed-worker": TEST_MODEL,
    },
    planner: { worker: TEST_MODEL },
    reviewer: { worker: TEST_MODEL },
    disabled: { worker: TEST_MODEL },
  },
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
          agentName: "reviewer",
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
      delegationModelRoutes: { planner: { worker: TEST_MODEL } },
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
          model: { ...TEST_MODEL, providerId: "other-provider", model: "other-model" },
        },
      },
      {
        name: "同 Provider 非命名目标模型",
        policy: parentPolicy,
        request: {
          ...baseRequest,
          model: { ...TEST_MODEL, model: "unapproved-model" },
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

  it("按发起 Agent 的预算作用域选择命名目标模型路由", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-model-scope-parent", store);
    await journal.start({ configFingerprint: "model-scope-parent" });
    const workerModel = { ...TEST_MODEL, model: "worker-model" };
    const scopedBudget = testParentPolicy().budget;
    const scopedHierarchy = { maxDepth: 3, maxActiveChildren: 1, maxDescendants: 4 };
    let executions = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-model-scope-parent",
      parentJournal: journal,
      runStore: store,
      parentPolicy: {
        ...testParentPolicy(),
        delegationModelRoutes: { planner: { worker: workerModel } },
      },
      delegationBudgetPools: { planner: scopedBudget, "other-agent": scopedBudget },
      delegationHierarchyLimits: {
        planner: scopedHierarchy,
        "other-agent": scopedHierarchy,
      },
      adapter: {
        execute: async () => {
          executions += 1;
          return successfulChildResult();
        },
      },
      createChildRunId: () => `run-model-scope-child-${executions}`,
    });
    const request = {
      ...testDelegationRequest("delegation-model-scope"),
      budgetScope: "planner",
      model: workerModel,
    };

    await (await coordinator.delegate(request)).join();
    await expect(
      coordinator.delegate({
        ...request,
        delegationId: "delegation-wrong-model-scope",
        budgetScope: "other-agent",
      }),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    await expect(
      coordinator.delegate({
        ...request,
        delegationId: "delegation-missing-model-route-fallback",
        budgetScope: "other-agent",
        model: testParentPolicy().model,
      }),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    expect(executions).toBe(1);
  });

  it("命名路由与请求同时省略 provenance 指纹时在创建 Fact 前失败关闭", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-model-provenance-missing", store);
    await journal.start({ configFingerprint: "model-provenance-missing" });
    const unboundModel = {
      providerId: TEST_MODEL.providerId,
      model: TEST_MODEL.model,
    } as typeof TEST_MODEL;
    let executions = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-model-provenance-missing",
      parentJournal: journal,
      runStore: store,
      parentPolicy: {
        ...testParentPolicy(),
        delegationModelRoutes: { __default__: { worker: unboundModel } },
      },
      adapter: {
        execute: async () => {
          executions += 1;
          return successfulChildResult();
        },
      },
      createChildRunId: () => "run-model-provenance-missing-child",
    });

    await expect(
      coordinator.delegate({
        ...testDelegationRequest("delegation-model-provenance-missing"),
        model: unboundModel,
      }),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    expect(executions).toBe(0);
    expect(
      (await store.read("run-model-provenance-missing")).filter(
        (record) => record.kind === "delegation",
      ),
    ).toEqual([]);
  });

  it("父策略缺少命名模型路由表时在创建 Fact 前失败关闭", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-model-routes-missing", store);
    await journal.start({ configFingerprint: "model-routes-missing" });
    const { delegationModelRoutes: _routes, ...routeLessPolicy } = testParentPolicy();
    let executions = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-model-routes-missing",
      parentJournal: journal,
      runStore: store,
      parentPolicy: routeLessPolicy,
      adapter: {
        execute: async () => {
          executions += 1;
          return successfulChildResult();
        },
      },
      createChildRunId: () => "run-model-routes-missing-child",
    });

    await expect(
      coordinator.delegate(testDelegationRequest("delegation-model-routes-missing")),
    ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    expect(executions).toBe(0);
    expect(
      (await store.read("run-model-routes-missing")).filter(
        (record) => record.kind === "delegation",
      ),
    ).toEqual([]);
  });

  it("委派入口快照阻止调用方在 Fact 持久化前篡改 authority", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-frozen-authority", store);
    await journal.start({ configFingerprint: "frozen-authority" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-frozen-authority",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async (input) => {
          expect(Object.isFrozen(input)).toBe(true);
          expect(Object.isFrozen(input.request)).toBe(true);
          expect(Object.isFrozen(input.inheritedPolicy)).toBe(true);
          expect(() => {
            (input.request as { task: string }).task = "篡改任务";
          }).toThrow(TypeError);
          expect(input.request.task).toBe("执行确定性测试子任务");
          expect(input.request.context.references).toEqual([]);
          return successfulChildResult();
        },
      },
      createChildRunId: () => "run-frozen-authority-child",
    });

    const request = testDelegationRequest("delegation-frozen-authority");
    const expectedFingerprint = childRunInputFingerprint(request);
    const pendingHandle = coordinator.delegate(request);
    request.task = "Fact 持久化前篡改任务";
    request.context.references.push("fact:unauthorized");
    await (await pendingHandle).join();
    const persisted = (await store.read("run-frozen-authority")).find(
      (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
    )?.payload;
    expect(persisted).toMatchObject({
      inputFingerprint: expectedFingerprint,
      context: { references: [] },
    });
    expect(persisted).not.toHaveProperty("task");
  });

  it("单次委派只能收紧后代深度、活动子级数与后代总数", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-hierarchy-parent", store);
    await journal.start({ configFingerprint: "hierarchy-parent" });
    let inheritedPolicy: ChildRunPolicySnapshot | undefined;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-hierarchy-parent",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async (input) => {
          inheritedPolicy = input.inheritedPolicy;
          return successfulChildResult();
        },
      },
      createChildRunId: () => "run-hierarchy-child",
    });
    const request = {
      ...testDelegationRequest("delegation-hierarchy"),
      allocation: {
        ...testDelegationRequest("delegation-hierarchy").allocation,
        descendants: 2,
      },
      hierarchyLimits: {
        maxDepth: 1,
        maxActiveChildren: 0,
      },
    };

    await (await coordinator.delegate(request)).join();
    expect(inheritedPolicy).toMatchObject({
      depth: 1,
      maxDepth: 1,
      maxActiveChildren: 0,
      maxDescendants: 2,
    });
    expect(
      (await store.read("run-hierarchy-parent"))
        .filter((record) => record.kind === "delegation")
        .map((record) => record.payload),
    ).toContainEqual(
      expect.objectContaining({
        type: "delegation_recorded",
        inheritedPolicy: expect.objectContaining({
          maxDepth: 1,
          maxActiveChildren: 0,
          maxDescendants: 2,
        }),
      }),
    );

    const childJournal = new RunStateJournal("run-hierarchy-child", store);
    await childJournal.start({ configFingerprint: "hierarchy-child" });
    const childCoordinator = await ChildRunCoordinator.open({
      parentRunId: "run-hierarchy-child",
      parentJournal: childJournal,
      runStore: store,
      parentPolicy: inheritedPolicy!,
      adapter: { execute: async () => successfulChildResult() },
      createChildRunId: () => "must-not-create",
    });
    await expect(
      childCoordinator.delegate(testDelegationRequest("delegation-must-not-expand")),
    ).rejects.toMatchObject({ code: "child_run_concurrency_limit" });

    for (const hierarchyLimits of [{ maxDepth: 4 }, { maxActiveChildren: 5 }]) {
      await expect(
        coordinator.delegate({
          ...testDelegationRequest(`delegation-expand-${Object.keys(hierarchyLimits)[0]}`),
          hierarchyLimits,
        }),
      ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    }
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
    expect(coordinator.isExecutionQuiescent()).toBe(true);
    expect(coordinator.isQuiescent()).toBe(false);
    expect(await handle.join()).toMatchObject({
      outcome: { status: "aborted", finishReason: "parent_cancelled" },
    });
    expect(coordinator.isQuiescent()).toBe(false);
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
    await coordinator.recordDisposition({
      dispositionId: "disposition-child-cancel",
      delegationId: request.delegationId,
      action: "accept_failure",
      decidedBy: "human",
      reason: "测试已确认取消前没有发生 Effect",
    });

    const timedOut = await coordinator.delegate({
      ...request,
      delegationId: "delegation-join-timeout",
      task: "等待 join timeout",
    });
    expect(await timedOut.join({ timeoutMs: 1 })).toMatchObject({
      outcome: { status: "timeout", finishReason: "child_join_timeout" },
    });
    expect(coordinator.isExecutionQuiescent()).toBe(true);
    expect(coordinator.isQuiescent()).toBe(false);
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

    expect(resumed.continuationGate()).toMatchObject({
      status: "disposition_required",
      delegationId: request.delegationId,
      requiredActor: "human",
    });
    expect(
      (await store.read(parentRunId)).flatMap((record) =>
        record.kind === "delegation" ? [record.payload.type] : [],
      ),
    ).toEqual(expect.arrayContaining(["child_orphaned", "parent_joined"]));
    const orphanHandle = await resumed.delegate(request);
    expect(restartedExecutions).toBe(0);
    expect(await orphanHandle.join()).toMatchObject({
      outcome: {
        status: "paused",
        finishReason: "child_run_orphaned",
        error: { code: "child_run_orphan_audit_required" },
      },
    });
    expect(resumed.isExecutionQuiescent()).toBe(true);
    expect(resumed.isQuiescent()).toBe(false);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          childRunId: "run-child-orphan",
          status: "joined",
          disposition: expect.objectContaining({ state: "required", requiredActor: "human" }),
        }),
      ],
      activeDescendants: 0,
      unhandledDescendants: 1,
      quiescent: false,
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
        model: TEST_MODEL,
        workspace: TEST_WORKSPACE,
        protectedContextReferences: [],
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

  it("创建前初始化失败释放完整六维父级预留", async () => {
    const baseStore = durableMemoryRunStore();
    const store: RunStore = {
      ...baseStore,
      commit: async (record, durability) => {
        if (record.kind === "delegation") throw new Error("delegation-init-failed");
        return baseStore.commit!(record, durability);
      },
    };
    const journal = new RunStateJournal("run-init-release", store);
    await journal.start({ configFingerprint: "init-release" });
    const request = testDelegationRequest("delegation-init-release");
    const released: ChildRunBudgetAllocation[] = [];
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-init-release",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: { execute: async () => successfulChildResult() },
      createChildRunId: () => "run-init-release-child",
      reserveParentBudget: (allocation) => {
        const reserved = structuredClone(allocation);
        return () => released.push(reserved);
      },
    });

    await expect(coordinator.delegate(request)).rejects.toThrow("delegation-init-failed");
    expect(released).toEqual([request.allocation]);
    expect(await store.read("run-init-release")).toEqual([
      expect.objectContaining({ kind: "start" }),
    ]);
  });

  it("recorded 已持久化而 child_created 提交未知时保留身份与预留并禁止重放", async () => {
    const baseStore = durableMemoryRunStore();
    let failChildCreated = true;
    const store: RunStore = {
      ...baseStore,
      commit: async (record, durability) => {
        if (
          failChildCreated &&
          record.kind === "delegation" &&
          (record.payload as { type?: string }).type === "child_created"
        ) {
          failChildCreated = false;
          throw new Error("child-created-commit-failed");
        }
        return baseStore.commit!(record, durability);
      },
    };
    const parentRunId = "run-created-commit-failure";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "created-commit-failure" });
    const request = testDelegationRequest("delegation-created-commit-failure");
    const released: ChildRunBudgetAllocation[] = [];
    let childIds = 0;
    let executions = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          executions += 1;
          return successfulChildResult();
        },
      },
      createChildRunId: () => `run-created-commit-failure-child-${++childIds}`,
      reserveParentBudget: (allocation) => {
        const reserved = structuredClone(allocation);
        return () => released.push(reserved);
      },
    });

    await expect(coordinator.delegate(request)).rejects.toThrow("child-created-commit-failed");
    const replay = await coordinator.delegate(request);

    expect(replay.childRunId).toBe("run-created-commit-failure-child-1");
    await expect(replay.join()).rejects.toThrow("child-created-commit-failed");
    expect(childIds).toBe(1);
    expect(executions).toBe(0);
    expect(released).toEqual([]);
    expect(
      (await store.read(parentRunId)).filter((record) => record.kind === "delegation"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ type: "delegation_recorded" }),
      }),
    ]);
    await expect(coordinator.delegate({ ...request, task: "不同输入" })).rejects.toMatchObject({
      code: "delegation_conflict",
    });
  });

  it("首个 recorded 已落盘但返回异常时回读确认并保留身份与预留", async () => {
    const baseStore = durableMemoryRunStore();
    let failAfterRecordedCommit = true;
    const store: RunStore = {
      ...baseStore,
      commit: async (record, durability) => {
        const committed = await baseStore.commit!(record, durability);
        if (
          failAfterRecordedCommit &&
          record.kind === "delegation" &&
          (record.payload as { type?: string }).type === "delegation_recorded"
        ) {
          failAfterRecordedCommit = false;
          throw new Error("delegation-recorded-ack-unknown");
        }
        return committed;
      },
    };
    const parentRunId = "run-recorded-ack-unknown";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "recorded-ack-unknown" });
    const request = testDelegationRequest("delegation-recorded-ack-unknown");
    const released: ChildRunBudgetAllocation[] = [];
    let childIds = 0;
    let executions = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          executions += 1;
          return successfulChildResult();
        },
      },
      createChildRunId: () => `run-recorded-ack-unknown-child-${++childIds}`,
      reserveParentBudget: (allocation) => {
        const reserved = structuredClone(allocation);
        return () => released.push(reserved);
      },
    });

    await expect(coordinator.delegate(request)).rejects.toThrow("delegation-recorded-ack-unknown");
    const replay = await coordinator.delegate(request);

    expect(replay.childRunId).toBe("run-recorded-ack-unknown-child-1");
    await expect(replay.join()).rejects.toThrow("delegation-recorded-ack-unknown");
    expect(childIds).toBe(1);
    expect(executions).toBe(0);
    expect(released).toEqual([]);
    expect(
      (await store.read(parentRunId)).filter((record) => record.kind === "delegation"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ type: "delegation_recorded" }),
      }),
    ]);
    await expect(coordinator.delegate({ ...request, task: "不同输入" })).rejects.toMatchObject({
      code: "delegation_conflict",
    });
  });

  it.each(["tokens", "toolCalls", "costUsd", "wallTimeMs", "steps", "descendants"] as const)(
    "Child Run 创建成功后不退还 %s 预留",
    async (dimension) => {
      const store = durableMemoryRunStore();
      const parentRunId = `run-no-refund-${dimension}`;
      const journal = new RunStateJournal(parentRunId, store);
      await journal.start({ configFingerprint: `no-refund-${dimension}` });
      const request = {
        ...testDelegationRequest(`delegation-no-refund-${dimension}-1`),
        allocation: {
          tokens: 1,
          toolCalls: 1,
          costUsd: 1,
          wallTimeMs: 1,
          steps: 1,
          descendants: 0,
        },
      };
      const parentBudget: ChildRunBudgetAllocation = {
        tokens: 2,
        toolCalls: 2,
        costUsd: 2,
        wallTimeMs: 2,
        steps: 2,
        descendants: 2,
      };
      parentBudget[dimension] = 1;
      const coordinator = await ChildRunCoordinator.open({
        parentRunId,
        parentJournal: journal,
        runStore: store,
        parentPolicy: {
          ...testParentPolicy(),
          budget: parentBudget,
          maxDescendants: parentBudget.descendants,
        },
        adapter: { execute: async () => successfulChildResult() },
        createChildRunId: (() => {
          let id = 0;
          return () => `${parentRunId}:child:${++id}`;
        })(),
      });

      await (await coordinator.delegate(request)).join();
      await expect(
        coordinator.delegate({
          ...request,
          delegationId: `delegation-no-refund-${dimension}-2`,
        }),
      ).rejects.toMatchObject({ code: "child_run_policy_escalation" });
    },
  );

  it("不同父 Agent 使用独立委派预算池，且预算作用域随 Fact 持久化", async () => {
    const store = durableMemoryRunStore();
    const journal = new RunStateJournal("run-budget-scopes", store);
    await journal.start({ configFingerprint: "budget-scopes" });
    const scopedBudget: ChildRunBudgetAllocation = {
      tokens: 10,
      toolCalls: 1,
      costUsd: 1,
      wallTimeMs: 1_000,
      steps: 1,
      descendants: 1,
    };
    const coordinator = await ChildRunCoordinator.open({
      parentRunId: "run-budget-scopes",
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      delegationBudgetPools: {
        planner: scopedBudget,
        reviewer: scopedBudget,
        disabled: scopedBudget,
      },
      delegationHierarchyLimits: {
        planner: { maxDepth: 3, maxActiveChildren: 1, maxDescendants: 1 },
        reviewer: { maxDepth: 3, maxActiveChildren: 1, maxDescendants: 1 },
        disabled: { maxDepth: 3, maxActiveChildren: 0, maxDescendants: 1 },
      },
      adapter: { execute: async () => successfulChildResult() },
      createChildRunId: (() => {
        let id = 0;
        return () => `run-budget-scope-child-${++id}`;
      })(),
    });
    const requestFor = (budgetScope: string, suffix: string) => ({
      ...testDelegationRequest(`delegation-${budgetScope}-${suffix}`),
      budgetScope,
      allocation: {
        tokens: 10,
        toolCalls: 1,
        costUsd: 1,
        wallTimeMs: 1_000,
        steps: 1,
        descendants: 0,
      },
    });

    await expect(coordinator.delegate(requestFor("disabled", "first"))).rejects.toMatchObject({
      code: "child_run_concurrency_limit",
    });
    await (await coordinator.delegate(requestFor("planner", "first"))).join();
    await (await coordinator.delegate(requestFor("reviewer", "first"))).join();
    await expect(coordinator.delegate(requestFor("planner", "second"))).rejects.toMatchObject({
      code: "child_run_policy_escalation",
    });
    expect(
      (await store.read("run-budget-scopes"))
        .filter(
          (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
        )
        .map((record) => (record.payload as { budgetScope?: string }).budgetScope),
    ).toEqual(["planner", "reviewer"]);
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
      parentPolicy: {
        ...childPolicy!,
        delegationModelRoutes: { __default__: { grandchild: TEST_MODEL } },
      },
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
          if (firstResult.outcome.status !== "succeeded") {
            await coordinator.recordDisposition({
              dispositionId: `disposition-seed-${seed}-${child}`,
              delegationId: requests[child]!.delegationId,
              action: "accept_failure",
              decidedBy: "human",
              reason: "属性测试已确认模拟 Adapter 不产生外部 Effect",
            });
          }
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

  it("旧版字符串 Workspace 变更 Fact 可迁移为证据并继续重建 Child tree", async () => {
    const parentRunId = "run-legacy-workspace-change-parent";
    const childRunId = "run-legacy-workspace-change-child";
    const request = testDelegationRequest("delegation-legacy-workspace-change");
    const inputFingerprint = childRunInputFingerprint(request);
    const store = new MemoryRunStore();
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "legacy-workspace-change" });
    const identity = {
      parentRunId,
      childRunId,
      delegationId: request.delegationId,
      inputFingerprint,
      recordedAt: "2026-08-27T00:00:00.000Z",
    };
    const legacyResult = {
      outcome: { status: "succeeded", finishReason: "completed" },
      evidence: [],
      artifacts: [],
      workspaceChanges: ["checkpoint:legacy-workspace-change"],
      unresolvedRisks: [],
    };
    await journal.appendFact("delegation", {
      ...identity,
      type: "delegation_recorded",
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
    });
    await journal.appendFact("delegation", { ...identity, type: "child_created" });
    await journal.appendFact("delegation", { ...identity, type: "child_running" });
    await journal.appendFact("delegation", {
      ...identity,
      type: "child_terminal",
      result: legacyResult,
    });
    await journal.appendFact("delegation", {
      ...identity,
      type: "parent_joined",
      result: legacyResult,
    });

    const projection = ProjectionEngine.project(await store.read(parentRunId));

    expect(projection.childRuns?.nodes[0]?.result).toMatchObject({
      evidence: ["checkpoint:legacy-workspace-change"],
      workspaceChanges: [],
      unresolvedRisks: [expect.stringContaining("历史 Child Run")],
    });
    let adapterExecutions = 0;
    const restarted = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: new RunStateJournal(
        parentRunId,
        store,
        (await store.read(parentRunId)).length,
      ),
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          adapterExecutions += 1;
          return successfulChildResult();
        },
      },
      createChildRunId: () => "run-should-not-be-created",
    });
    const restored = await (await restarted.delegate(request)).join();
    expect(restored).toMatchObject({
      evidence: ["checkpoint:legacy-workspace-change"],
      workspaceChanges: [],
    });
    expect(adapterExecutions).toBe(0);
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
      expect(coordinator.isExecutionQuiescent()).toBe(true);
      expect(coordinator.isQuiescent()).toBe(false);
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
    expect(coordinator.isExecutionQuiescent()).toBe(true);
    expect(coordinator.isQuiescent()).toBe(false);
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
    expect(coordinator.isExecutionQuiescent()).toBe(true);
    expect(coordinator.isQuiescent()).toBe(false);
  });

  it("成功且已静止的 committed Effect 默认接受，但不能作为安全重委派证明", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-success-committed-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "success-committed" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          ...successfulChildResult(),
          recovery: {
            recoveryDisposition: "requires_human",
            effectState: "committed",
            quiescent: true,
            executionOwnership: "released",
            evidence: ["event:effect-committed"],
          },
        }),
      },
      createChildRunId: () => "run-success-committed-child",
    });

    await (
      await coordinator.delegate(testDelegationRequest("delegation-success-committed"))
    ).join();

    expect(coordinator.continuationGate()).toEqual({ status: "allowed" });
    expect(coordinator.isQuiescent()).toBe(true);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          disposition: expect.objectContaining({
            state: "not_required",
            recoveryDisposition: "requires_human",
          }),
        }),
      ],
      unhandledDescendants: 0,
      quiescent: true,
    });
  });

  it.each([
    {
      id: "unknown-effect",
      recovery: {
        recoveryDisposition: "requires_human" as const,
        effectState: "unknown" as const,
        quiescent: true,
        executionOwnership: "released" as const,
        evidence: ["event:effect-unknown"],
      },
    },
    {
      id: "started-effect",
      recovery: {
        recoveryDisposition: "forbidden" as const,
        effectState: "started" as const,
        quiescent: true,
        executionOwnership: "released" as const,
        evidence: ["event:effect-started"],
      },
    },
    {
      id: "not-quiescent",
      recovery: {
        recoveryDisposition: "requires_human" as const,
        effectState: "none" as const,
        quiescent: false,
        executionOwnership: "released" as const,
        evidence: ["runtime:not-quiescent"],
      },
    },
    {
      id: "ownership-unknown",
      recovery: {
        recoveryDisposition: "requires_human" as const,
        effectState: "none" as const,
        quiescent: true,
        executionOwnership: "unknown" as const,
        evidence: ["execution_ownership:unknown"],
      },
    },
  ])("成功 Child 的 $id 风险仍要求人工持久处置", async ({ id, recovery }) => {
    const store = durableMemoryRunStore();
    const parentRunId = `run-risky-success-${id}-parent`;
    const delegationId = `delegation-risky-success-${id}`;
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: `risky-success-${id}` });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: { execute: async () => ({ ...successfulChildResult(), recovery }) },
      createChildRunId: () => `run-risky-success-${id}-child`,
    });

    await (await coordinator.delegate(testDelegationRequest(delegationId))).join();

    expect(coordinator.continuationGate()).toMatchObject({
      status: "disposition_required",
      delegationId,
      requiredActor: "human",
    });
    expect(coordinator.isExecutionQuiescent()).toBe(true);
    expect(coordinator.isQuiescent()).toBe(false);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          disposition: expect.objectContaining({ state: "required", requiredActor: "human" }),
        }),
      ],
      unhandledDescendants: 1,
      quiescent: false,
    });

    await coordinator.recordDisposition({
      dispositionId: `disposition-risky-success-${id}`,
      delegationId,
      action: "accept_failure",
      decidedBy: "human",
      reason: "人工已核对异常成功结果并接受为已处理风险",
    });
    expect(coordinator.continuationGate()).toEqual({ status: "allowed" });
    expect(coordinator.isQuiescent()).toBe(true);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          disposition: expect.objectContaining({
            state: "recorded",
            action: "accept_failure",
            decidedBy: "human",
          }),
        }),
      ],
      unhandledDescendants: 0,
      quiescent: true,
    });

    const persisted = await store.read(parentRunId);
    const restored = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: new RunStateJournal(parentRunId, store, persisted.at(-1)?.sequence ?? 0),
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          throw new Error("已处置的异常成功 Child 不得在 Resume 时重跑");
        },
      },
      createChildRunId: () => `run-risky-success-${id}-unexpected`,
    });
    expect(restored.continuationGate()).toEqual({ status: "allowed" });
    expect(restored.isQuiescent()).toBe(true);
  });

  it("非成功 join 必须持久化明确处置，重启后仍保持已处理状态", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-disposition-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "disposition" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => safeFailedChildResult(),
      },
      createChildRunId: () => "run-disposition-child",
    });

    await (await coordinator.delegate(testDelegationRequest("delegation-disposition"))).join();

    expect(coordinator.continuationGate()).toMatchObject({
      status: "disposition_required",
      delegationId: "delegation-disposition",
      requiredActor: "parent_agent",
    });
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          status: "joined",
          disposition: expect.objectContaining({
            state: "required",
            requiredActor: "parent_agent",
            recoveryDisposition: "replay_safe",
          }),
        }),
      ],
      unhandledDescendants: 1,
      quiescent: false,
    });

    const disposition = await coordinator.recordDisposition({
      dispositionId: "disposition-1",
      delegationId: "delegation-disposition",
      action: "accept_failure",
      decidedBy: "parent_agent",
      reason: "父级已记录失败并改走无副作用路径",
    });
    expect(disposition).toMatchObject({
      dispositionId: "disposition-1",
      action: "accept_failure",
      recovery: { recoveryDisposition: "replay_safe" },
    });
    expect(coordinator.continuationGate()).toEqual({ status: "allowed" });
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      nodes: [
        expect.objectContaining({
          disposition: expect.objectContaining({ state: "recorded", action: "accept_failure" }),
        }),
      ],
      unhandledDescendants: 0,
      quiescent: true,
    });

    expect(
      await coordinator.recordDisposition({
        dispositionId: "disposition-1",
        delegationId: "delegation-disposition",
        action: "accept_failure",
        decidedBy: "parent_agent",
        reason: "父级已记录失败并改走无副作用路径",
      }),
    ).toEqual(disposition);
    await expect(
      coordinator.recordDisposition({
        dispositionId: "disposition-2",
        delegationId: "delegation-disposition",
        action: "propagate_terminal",
        decidedBy: "parent_agent",
        reason: "冲突处置",
      }),
    ).rejects.toMatchObject({ code: "delegation_disposition_conflict" });

    const records = await store.read(parentRunId);
    const reopened = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: new RunStateJournal(parentRunId, store, records.length),
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: { execute: async () => successfulChildResult() },
      createChildRunId: () => "must-not-create",
    });
    expect(reopened.continuationGate()).toEqual({ status: "allowed" });
  });

  it("多个非成功 Child 必须全部处置后才能传播其中一个终态", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-multiple-dispositions-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "multiple-dispositions" });
    let releaseChildren!: () => void;
    const childrenMayFinish = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    let childSequence = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          await childrenMayFinish;
          return safeFailedChildResult();
        },
      },
      createChildRunId: () => `run-multiple-dispositions-child-${++childSequence}`,
    });

    const propagated = await coordinator.delegate(testDelegationRequest("delegation-propagated"));
    const unhandled = await coordinator.delegate(testDelegationRequest("delegation-unhandled"));
    releaseChildren();
    await Promise.all([propagated.join(), unhandled.join()]);
    await coordinator.recordDisposition({
      dispositionId: "disposition-propagated",
      delegationId: "delegation-propagated",
      action: "propagate_terminal",
      decidedBy: "parent_agent",
      reason: "传播第一个 Child 的终态",
    });

    expect(coordinator.continuationGate()).toMatchObject({
      status: "disposition_required",
      delegationId: "delegation-unhandled",
    });
  });

  it("多个非成功 Child 的未处置与传播终态都优先于安全重新委派", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-global-disposition-priority-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "global-disposition-priority" });
    let releaseChildren!: () => void;
    const childrenMayFinish = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    let childSequence = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => {
          await childrenMayFinish;
          return safeFailedChildResult();
        },
      },
      createChildRunId: () => `run-global-disposition-priority-child-${++childSequence}`,
    });

    const redelegated = await coordinator.delegate(testDelegationRequest("delegation-redelegate"));
    const terminal = await coordinator.delegate(testDelegationRequest("delegation-terminal"));
    releaseChildren();
    await Promise.all([redelegated.join(), terminal.join()]);
    await coordinator.recordDisposition({
      dispositionId: "disposition-redelegate-priority",
      delegationId: "delegation-redelegate",
      action: "redelegate",
      decidedBy: "parent_agent",
      reason: "原尝试在任何 Effect 前失败",
    });

    expect(coordinator.continuationGate()).toMatchObject({
      status: "disposition_required",
      delegationId: "delegation-terminal",
    });

    await coordinator.recordDisposition({
      dispositionId: "disposition-terminal-priority",
      delegationId: "delegation-terminal",
      action: "propagate_terminal",
      decidedBy: "parent_agent",
      reason: "传播 sibling 的终态并停止父级",
    });
    expect(coordinator.continuationGate()).toMatchObject({
      status: "propagate_terminal",
      delegationId: "delegation-terminal",
    });
    expect(coordinator.isExecutionQuiescent()).toBe(true);
    expect(coordinator.isQuiescent()).toBe(false);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      quiescent: false,
      unhandledDescendants: 1,
    });
    const { cancelPendingRedelegationsBeforeTerminal } = await import("./runtime.js");
    const gateAfterTerminal = await cancelPendingRedelegationsBeforeTerminal(
      coordinator,
      new CoreMindError("delegation_disposition_required", "传播 sibling 的同名真实终态"),
    );
    expect(gateAfterTerminal).toMatchObject({
      status: "propagate_terminal",
      delegationId: "delegation-terminal",
    });
    expect(
      (await store.read(parentRunId)).some(
        (record) =>
          record.kind === "delegation" &&
          record.payload.type === "delegation_redelegation_cancelled" &&
          record.payload.delegationId === "delegation-redelegate",
      ),
    ).toBe(true);
    expect(coordinator.isQuiescent()).toBe(true);
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns).toMatchObject({
      quiescent: true,
      unhandledDescendants: 0,
    });
  });

  it("多个未处置 Child 中需要人工处理的安全门优先于父 Agent 处置", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-human-disposition-priority-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "human-disposition-priority" });
    let releaseChildren!: () => void;
    const childrenMayFinish = new Promise<void>((resolve) => {
      releaseChildren = resolve;
    });
    let childSequence = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async ({ delegationId }) => {
          await childrenMayFinish;
          return delegationId === "delegation-parent-agent-disposition"
            ? safeFailedChildResult()
            : {
                ...safeFailedChildResult(),
                recovery: {
                  recoveryDisposition: "requires_human" as const,
                  effectState: "unknown" as const,
                  quiescent: true,
                  executionOwnership: "released" as const,
                  evidence: [],
                },
              };
        },
      },
      createChildRunId: () => `run-human-disposition-priority-child-${++childSequence}`,
    });

    const parentAgentDisposition = await coordinator.delegate(
      testDelegationRequest("delegation-parent-agent-disposition"),
    );
    const humanDisposition = await coordinator.delegate(
      testDelegationRequest("delegation-human-disposition"),
    );
    releaseChildren();
    await Promise.all([parentAgentDisposition.join(), humanDisposition.join()]);

    expect(coordinator.continuationGate()).toMatchObject({
      status: "disposition_required",
      delegationId: "delegation-human-disposition",
      requiredActor: "human",
    });
  });

  it("只有可证明 replay-safe 的处置才能建立使用新身份和新预算的关联尝试", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-redelegation-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "redelegation" });
    let childSequence = 0;
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async ({ delegationId }) =>
          delegationId === "delegation-attempt-1"
            ? safeFailedChildResult()
            : successfulChildResult(),
      },
      createChildRunId: () => `run-redelegation-child-${++childSequence}`,
    });
    const firstRequest = testDelegationRequest("delegation-attempt-1");
    await (await coordinator.delegate(firstRequest)).join();
    await coordinator.recordDisposition({
      dispositionId: "disposition-redelegate",
      delegationId: firstRequest.delegationId,
      action: "redelegate",
      decidedBy: "parent_agent",
      reason: "首次尝试在任何 Effect 前失败",
    });
    expect(coordinator.continuationGate()).toMatchObject({
      status: "redelegation_required",
      delegationId: firstRequest.delegationId,
    });

    await expect(coordinator.delegate(firstRequest)).resolves.toMatchObject({
      childRunId: "run-redelegation-child-1",
    });
    const secondRequest = {
      ...testDelegationRequest("delegation-attempt-2"),
      predecessorDelegationId: firstRequest.delegationId,
    };
    await (await coordinator.delegate(secondRequest)).join();
    expect(coordinator.continuationGate()).toEqual({ status: "allowed" });
    expect(ProjectionEngine.project(await store.read(parentRunId)).childRuns?.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delegationId: firstRequest.delegationId,
          disposition: expect.objectContaining({
            state: "recorded",
            action: "redelegate",
            successorDelegationId: secondRequest.delegationId,
          }),
        }),
        expect.objectContaining({
          delegationId: secondRequest.delegationId,
          predecessorDelegationId: firstRequest.delegationId,
        }),
      ]),
    );
    await expect(
      coordinator.delegate({
        ...testDelegationRequest("delegation-attempt-3"),
        predecessorDelegationId: firstRequest.delegationId,
      }),
    ).rejects.toMatchObject({ code: "delegation_redelegation_unsafe" });
  });

  it("父终态封口与撤销 Fact 之间不能并发建立重新委派 successor", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-terminal-sealed-redelegation-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "terminal-sealed-redelegation" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: { execute: async () => safeFailedChildResult() },
      createChildRunId: () => "run-terminal-sealed-redelegation-child",
    });
    const firstRequest = testDelegationRequest("delegation-before-terminal-seal");
    await (await coordinator.delegate(firstRequest)).join();
    await coordinator.recordDisposition({
      dispositionId: "disposition-before-terminal-seal",
      delegationId: firstRequest.delegationId,
      action: "redelegate",
      decidedBy: "parent_agent",
      reason: "首次尝试可安全重放",
    });
    let cancellationEntered!: () => void;
    let releaseCancellation!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      cancellationEntered = resolve;
    });
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const appendFact = journal.appendFact.bind(journal);
    journal.appendFact = async (kind, payload, options) => {
      if (
        kind === "delegation" &&
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        payload.type === "delegation_redelegation_cancelled"
      ) {
        cancellationEntered();
        await cancellationReleased;
      }
      return appendFact(kind, payload, options);
    };

    await coordinator.sealForTerminal();
    const cancellation = coordinator.cancelPendingRedelegations(
      "agent_failed",
      "父 Run 失败并撤销待重委派意图",
    );
    await cancellationStarted;
    const successor = coordinator.delegate({
      ...testDelegationRequest("delegation-after-terminal-seal"),
      predecessorDelegationId: firstRequest.delegationId,
    });
    releaseCancellation();

    await expect(successor).rejects.toMatchObject({ code: "child_run_unavailable" });
    await cancellation;
    const records = await store.read(parentRunId);
    expect(
      records.some(
        (record) =>
          record.kind === "delegation" &&
          record.payload.type === "delegation_recorded" &&
          record.payload.delegationId === "delegation-after-terminal-seal",
      ),
    ).toBe(false);
    expect(records.at(-1)).toMatchObject({
      kind: "delegation",
      payload: {
        type: "delegation_redelegation_cancelled",
        delegationId: firstRequest.delegationId,
      },
    });
  });

  it("orphan 与未知 Effect 强制等待人工处置，父 Agent 不能自行解封或重新委派", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-human-disposition-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "human-disposition" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          outcome: { status: "failed", finishReason: "agent_failed" },
          evidence: [],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: ["Effect 状态未知"],
          recovery: {
            recoveryDisposition: "requires_human",
            effectState: "unknown",
            quiescent: true,
            executionOwnership: "released",
            evidence: [],
          },
        }),
      },
      createChildRunId: () => "run-human-disposition-child",
    });
    await (await coordinator.delegate(testDelegationRequest("delegation-human-required"))).join();

    expect(coordinator.continuationGate()).toMatchObject({
      status: "disposition_required",
      requiredActor: "human",
    });
    await expect(
      coordinator.recordDisposition({
        dispositionId: "model-cannot-unblock",
        delegationId: "delegation-human-required",
        action: "accept_failure",
        decidedBy: "parent_agent",
        reason: "模型不能覆盖人工安全门",
      }),
    ).rejects.toMatchObject({ code: "delegation_disposition_required" });
    await expect(
      coordinator.recordDisposition({
        dispositionId: "human-cannot-retry-unknown",
        delegationId: "delegation-human-required",
        action: "redelegate",
        decidedBy: "human",
        reason: "尚无安全证明",
      }),
    ).rejects.toMatchObject({ code: "delegation_redelegation_unsafe" });
    await coordinator.recordDisposition({
      dispositionId: "human-propagates",
      delegationId: "delegation-human-required",
      action: "propagate_terminal",
      decidedBy: "human",
      reason: "人工核对后传播原终态",
    });
    expect(coordinator.continuationGate()).toMatchObject({
      status: "propagate_terminal",
      delegationId: "delegation-human-required",
    });
  });

  it("恢复与 Projection 拒绝绕过人工门或安全重委派门的处置 Fact", async () => {
    const store = durableMemoryRunStore();
    const parentRunId = "run-corrupt-disposition-parent";
    const journal = new RunStateJournal(parentRunId, store);
    await journal.start({ configFingerprint: "corrupt-disposition" });
    const coordinator = await ChildRunCoordinator.open({
      parentRunId,
      parentJournal: journal,
      runStore: store,
      parentPolicy: testParentPolicy(),
      adapter: {
        execute: async () => ({
          outcome: { status: "failed", finishReason: "agent_failed" },
          evidence: [],
          artifacts: [],
          workspaceChanges: [],
          unresolvedRisks: ["Effect 状态未知"],
          recovery: {
            recoveryDisposition: "requires_human",
            effectState: "unknown",
            quiescent: true,
            executionOwnership: "released",
            evidence: [],
          },
        }),
      },
      createChildRunId: () => "run-corrupt-disposition-child",
    });
    const delegationId = "delegation-corrupt-disposition";
    await (await coordinator.delegate(testDelegationRequest(delegationId))).join();
    await coordinator.recordDisposition({
      dispositionId: "disposition-corrupt-source",
      delegationId,
      action: "accept_failure",
      decidedBy: "human",
      reason: "人工确认后接受失败",
    });
    const records = await store.read(parentRunId);
    const corruptions = [{ decidedBy: "parent_agent" as const }, { action: "redelegate" as const }];

    for (const corruption of corruptions) {
      const corrupted = records.map((record) => {
        if (
          record.kind !== "delegation" ||
          typeof record.payload !== "object" ||
          record.payload === null ||
          !("type" in record.payload) ||
          record.payload.type !== "delegation_disposition_recorded"
        ) {
          return record;
        }
        return { ...record, payload: { ...record.payload, ...corruption } };
      });
      expect(() => ProjectionEngine.project(corrupted)).toThrowError(
        expect.objectContaining({ code: "run_state_corrupt" }),
      );

      const corruptedStore = durableMemoryRunStore();
      for (const record of corrupted) await corruptedStore.append(record);
      let childExecutions = 0;
      await expect(
        ChildRunCoordinator.open({
          parentRunId,
          parentJournal: new RunStateJournal(
            parentRunId,
            corruptedStore,
            corrupted.at(-1)?.sequence ?? 0,
          ),
          runStore: corruptedStore,
          parentPolicy: testParentPolicy(),
          adapter: {
            execute: async () => {
              childExecutions += 1;
              return successfulChildResult();
            },
          },
          createChildRunId: () => "must-not-create",
        }),
      ).rejects.toMatchObject({ code: "run_state_corrupt" });
      expect(childExecutions).toBe(0);
    }
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

function successfulChildResult(): ChildRunResult {
  return {
    outcome: { status: "succeeded" as const, finishReason: "done" },
    evidence: [],
    artifacts: [],
    workspaceChanges: [],
    unresolvedRisks: [],
    recovery: {
      recoveryDisposition: "replay_safe",
      effectState: "none",
      quiescent: true,
      executionOwnership: "released",
      evidence: [],
    },
  };
}

function safeFailedChildResult(): ChildRunResult {
  return {
    outcome: {
      status: "failed",
      finishReason: "agent_failed",
      error: { code: "agent_failed", message: "Child 在产生任何 Effect 前失败" },
    },
    evidence: [],
    artifacts: [],
    workspaceChanges: [],
    unresolvedRisks: [],
    recovery: {
      recoveryDisposition: "replay_safe",
      effectState: "none",
      quiescent: true,
      executionOwnership: "released",
      evidence: [],
    },
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
