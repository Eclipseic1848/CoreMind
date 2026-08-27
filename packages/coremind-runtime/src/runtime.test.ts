import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, vi } from "vitest";
import type { ChildRunExecutionInput } from "./child-run.js";
import { createCoreMindChildRunAdapter } from "./child-runtime-adapter.js";
import {
  applyCompaction,
  projectBranchMessages,
  projectRawBranchMessages,
} from "./compaction-projection.js";
import type { CoreMindEvent } from "./events.js";
import { checkInvariantFacts } from "./invariant-checker.js";
import { createDenyPolicyExtension, defineLifecycleExtension } from "./lifecycle-extension.js";
import {
  createTelemetryConsentFact,
  createTelemetryEgressAuthorization,
  TelemetryExporterError,
} from "./observability.js";
import { ProjectionEngine } from "./projection.js";
import type { CoreMindToolDefinition } from "./public-tool.js";
import {
  FileRunStore,
  fingerprintRunConfig,
  MemoryRunStore,
  prepareRunResume,
  RunStateJournal,
} from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";
import {
  canonicalizeWorkspace,
  projectWorkspaceLeasesFromRecords,
  WorkspaceLeaseService,
  workspaceLeasePath,
} from "./workspace-lease.js";

describe("CoreMindRuntime", () => {
  it("真实 Child Runtime Adapter 绑定 authority、执行独立 Run 并等待 Quiescent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-real-child-"));
    const server = createTextSequenceServer(["子任务完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config = toolConfig((server.address() as AddressInfo).port, {
        runtime: {
          maxSteps: 2,
          maxToolCalls: 2,
          maxTokens: 1_000,
          maxCostUsd: 10,
          runTimeoutMs: 5_000,
        },
      });
      const canonicalRoot = await canonicalizeWorkspace(dir);
      const policy = {
        depth: 1,
        model: { providerId: "probe", model: "probe-model" },
        workspace: { canonicalRoot, lease: "shared_canonical" as const },
        protectedContextReferences: [],
        budget: {
          tokens: 1_000,
          toolCalls: 2,
          costUsd: 10,
          wallTimeMs: 5_000,
          steps: 2,
          descendants: 0,
        },
        permissions: {
          mode: "ask" as const,
          workspaceOnly: true,
          network: "ask" as const,
          tools: ["read"],
          paths: ["."],
          credentials: [],
        },
        environment: {},
        maxDepth: 3,
        maxActiveChildren: 2,
        maxDescendants: 0,
      };
      const request = {
        delegationId: "delegation-real-child",
        parentTurnId: "turn-parent",
        parentStepId: "step-parent",
        agentName: "main",
        task: "执行真实子任务",
        model: policy.model,
        workspace: policy.workspace,
        lifecyclePolicy: {
          join: "structured" as const,
          cancel: "propagate_parent" as const,
          orphan: "audit_pause" as const,
          detach: "forbidden" as const,
        },
        context: { workingSetFingerprint: "sha256:real-child", references: [] },
        allocation: policy.budget,
        permissions: policy.permissions,
        environment: policy.environment,
      };
      const controller = new AbortController();
      const input: ChildRunExecutionInput = {
        parentRunId: "run-parent",
        childRunId: "run-real-child",
        delegationId: request.delegationId,
        inputFingerprint: "sha256:real-child-input",
        request,
        inheritedPolicy: policy,
        signal: controller.signal,
      };
      const store = new FileRunStore(path.join(dir, "runs"));
      const adapter = createCoreMindChildRunAdapter({
        createRuntime: (authority) =>
          CoreMindRuntime.create({
            config,
            configDir: dir,
            cwd: dir,
            initialPrompt: authority.request.task,
            runId: authority.childRunId,
            runStore: store,
            signal: authority.signal,
            childRunAuthority: authority,
          }),
      });

      await expect(adapter.execute(input)).resolves.toMatchObject({
        outcome: { status: "succeeded" },
      });
      expect((await store.read("run-real-child")).at(-1)?.kind).toBe("finish");
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Child Run 父策略必须绑定真实模型、Workspace、权限与有限 Runtime 预算", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-child-authority-"));
    const server = createTextSequenceServer(["不应调用"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const canonicalRoot = await canonicalizeWorkspace(dir);
      const basePolicy = {
        depth: 0,
        model: { providerId: "probe", model: "probe-model" },
        workspace: { canonicalRoot, lease: "shared_canonical" as const },
        protectedContextReferences: [],
        budget: {
          tokens: 100,
          toolCalls: 2,
          costUsd: 1,
          wallTimeMs: 1_000,
          steps: 2,
          descendants: 2,
        },
        permissions: {
          mode: "ask" as const,
          workspaceOnly: true,
          network: "ask" as const,
          tools: ["read"],
          paths: ["."],
          credentials: [],
        },
        environment: { networkEgress: "controlled" as const },
        maxDepth: 3,
        maxActiveChildren: 2,
      };
      const childRuns = {
        parentPolicy: basePolicy,
        adapter: createCoreMindChildRunAdapter({
          createRuntime: async () => ({
            verifyChildRunAuthority: async () => undefined,
            run: async () => ({ runId: "run-child" }) as never,
            waitForQuiescence: async () => true,
          }),
        }),
        createChildRunId: () => "run-child",
      };
      const boundedConfig = toolConfig(port, {
        runtime: { maxTokens: 1_000, maxCostUsd: 10 },
      });
      const wrongModel = await CoreMindRuntime.create({
        config: boundedConfig,
        configDir: dir,
        cwd: dir,
        childRuns: {
          ...childRuns,
          parentPolicy: { ...basePolicy, model: { providerId: "other", model: "other" } },
        },
      });
      await expect(wrongModel.run()).rejects.toMatchObject({
        code: "child_run_policy_escalation",
      });

      const unbounded = await CoreMindRuntime.create({
        config: toolConfig(port, {}),
        configDir: dir,
        cwd: dir,
        childRuns,
      });
      await expect(unbounded.run()).rejects.toMatchObject({
        code: "child_run_policy_escalation",
      });

      const widerTools = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            runtime: {
              maxTokens: 100,
              maxCostUsd: 1,
              maxToolCalls: 2,
              runTimeoutMs: 1_000,
              maxSteps: 2,
            },
          }),
          tools: [{ id: "read" }, { id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        childRuns,
      });
      await expect(widerTools.run()).rejects.toMatchObject({
        code: "child_run_policy_escalation",
      });

      const arbitraryAdapter = await CoreMindRuntime.create({
        config: toolConfig(port, {
          runtime: {
            maxTokens: 100,
            maxCostUsd: 1,
            maxToolCalls: 2,
            runTimeoutMs: 1_000,
            maxSteps: 2,
          },
        }),
        configDir: dir,
        cwd: dir,
        childRuns: {
          ...childRuns,
          adapter: { execute: async () => ({}) } as never,
        },
      });
      await expect(arbitraryAdapter.run()).rejects.toMatchObject({
        code: "child_run_identity_mismatch",
      });
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Resume 不能在未配置 Coordinator 时绕过未处置 Child Run 的 orphan audit", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-child-resume-"));
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const config = toolConfig((server.address() as AddressInfo).port, {});
      const store = new FileRunStore(path.join(dir, "runs"));
      const journal = new RunStateJournal("run-child-interrupted", store);
      await journal.start({
        configFingerprint: fingerprintRunConfig(config),
        initialPrompt: "继续父任务",
      });
      const policy = {
        depth: 1,
        model: { providerId: "probe", model: "probe-model" },
        workspace: { canonicalRoot: await canonicalizeWorkspace(dir), lease: "shared_canonical" },
        protectedContextReferences: [],
        budget: {
          tokens: 10,
          toolCalls: 1,
          costUsd: 1,
          wallTimeMs: 1_000,
          steps: 1,
          descendants: 0,
        },
        permissions: {
          mode: "ask",
          workspaceOnly: true,
          network: "ask",
          tools: ["read"],
          paths: ["."],
          credentials: [],
        },
        environment: { networkEgress: "controlled" },
        maxDepth: 3,
        maxActiveChildren: 2,
        maxDescendants: 0,
      } as const;
      const identity = {
        parentRunId: "run-child-interrupted",
        childRunId: "run-child-orphan",
        delegationId: "delegation-orphan",
        inputFingerprint: "sha256:orphan",
      };
      await journal.appendFact(
        "delegation",
        {
          type: "delegation_recorded",
          ...identity,
          parentTurnId: "turn-parent",
          parentStepId: "step-parent",
          agentName: "worker",
          model: policy.model,
          workspace: policy.workspace,
          lifecyclePolicy: {
            join: "structured",
            cancel: "propagate_parent",
            orphan: "audit_pause",
            detach: "forbidden",
          },
          context: { workingSetFingerprint: "sha256:context", references: [] },
          inheritedPolicy: policy,
          requestedAllocation: policy.budget,
          requestedPermissions: policy.permissions,
          requestedEnvironment: policy.environment,
          recordedAt: "2026-08-27T00:00:00.000Z",
        },
        { durability: "critical" },
      );
      await journal.appendFact(
        "delegation",
        { type: "child_created", ...identity, recordedAt: "2026-08-27T00:00:01.000Z" },
        { durability: "critical" },
      );
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: dir,
        cwd: dir,
        initialPrompt: "继续父任务",
        resumeRunId: "run-child-interrupted",
        runStore: store,
      });

      await expect(runtime.run()).rejects.toMatchObject({
        code: "child_run_orphan_audit_required",
      });
      expect(providerCalls).toBe(0);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("把 Protocol v2 start 身份持久化到权威 start Fact", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-protocol-start-"));
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new FileRunStore(path.join(dir, "runs"));
    const protocolStart = {
      protocolVersion: "2.0" as const,
      method: "run" as const,
      fingerprint: "start-fingerprint",
      acceptedAt: "2026-08-25T00:00:00.000Z",
    };

    try {
      const runtime = await CoreMindRuntime.create({
        config: toolConfig((server.address() as AddressInfo).port, {}),
        configDir: dir,
        cwd: dir,
        initialPrompt: "执行",
        runId: "protocol-start-run",
        runStore: store,
        protocolStart,
      });

      await runtime.run();
      const start = (await store.read("protocol-start-run")).find(
        (record) => record.kind === "start",
      );

      expect(start?.payload).toMatchObject({ protocolStart });
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Workspace 写租约被占用时在 Checkpoint 和 Adapter 前失败关闭", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-lease-busy-"));
    const target = path.join(dir, "article.md");
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const blocker = await new WorkspaceLeaseService().acquire({
      workspaceRoot: dir,
      lane: "workspace_exclusive",
      owner: { runId: "blocking-run", callId: "blocking-call" },
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: { ...toolConfig(port, {}), tools: [{ id: "write" }] },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        approveTool: async () => "allow",
        runStore: new FileRunStore(path.join(dir, "runs")),
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "workspace_busy" },
      });
      expect(existsSync(target)).toBe(false);
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "checkpoint_created" ||
            (entry.event.type === "tool_lifecycle" &&
              entry.event.resolution.phase === "checkpoint_durable" &&
              entry.event.resolution.status === "completed"),
        ),
      ).toBe(false);
    } finally {
      await blocker.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
      await closeServer(server);
    }
  });

  it("Workspace Lease 在 checkpoint 前取得，并在结果关键 Fact 后静止释放", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-lease-order-"));
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const leaseService = new WorkspaceLeaseService();
    const store = new FileRunStore(path.join(dir, "runs"));

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: { ...toolConfig(port, {}), tools: [{ id: "write" }] },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        approveTool: async () => "allow",
        runStore: store,
      });

      const result = await runtime.run();
      const lifecycle = result.trace.flatMap((entry) =>
        entry.event.type === "tool_lifecycle" ? [entry.event.resolution] : [],
      );
      const resultDurableIndex = result.trace.findIndex(
        (entry) =>
          entry.event.type === "tool_lifecycle" &&
          entry.event.resolution.phase === "result_durable",
      );
      const releasedIndex = result.trace.findIndex(
        (entry) => entry.event.type === "workspace_lease" && entry.event.status === "released",
      );

      expect(result.outcome.status).toBe("succeeded");
      expect(lifecycle.findIndex((item) => item.phase === "lease_acquired")).toBeLessThan(
        lifecycle.findIndex((item) => item.phase === "checkpoint_durable"),
      );
      expect(releasedIndex).toBeGreaterThan(resultDurableIndex);
      expect(result.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ type: "workspace_lease", status: "acquired" }),
          }),
          expect.objectContaining({
            event: expect.objectContaining({ type: "workspace_lease", status: "released" }),
          }),
        ]),
      );
      expect(await leaseService.inspect(dir)).toEqual({
        state: "available",
        canonicalRoot: await canonicalizeWorkspace(dir),
      });
      expect(projectWorkspaceLeasesFromRecords(await store.read(result.runId))).toEqual([
        expect.objectContaining({ callId: "call-write", status: "released" }),
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("遗留 Workspace Lease 先持久化 recovery_required，再暂停等待显式恢复", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-lease-recovery-"));
    const canonicalRoot = await canonicalizeWorkspace(dir);
    const lockPath = workspaceLeasePath(canonicalRoot);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        canonicalRoot,
        runId: "dead-run",
        callId: "dead-call",
        pid: 2_147_483_647,
        nonce: "dead-runtime-owner",
        acquiredAt: "2026-08-23T00:00:00.000Z",
      }),
      "utf8",
    );
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const leaseService = new WorkspaceLeaseService();

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: { ...toolConfig(port, {}), tools: [{ id: "write" }] },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        approveTool: async () => "allow",
        runStore: new FileRunStore(path.join(dir, "runs")),
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "workspace_lease_recovery_required" },
      });
      expect(result.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "workspace_lease",
              status: "recovery_required",
              owner: expect.objectContaining({ runId: "dead-run" }),
            }),
          }),
        ]),
      );
      expect(existsSync(path.join(dir, "article.md"))).toBe(false);
    } finally {
      await leaseService.recover(dir, "dead-runtime-owner");
      await closeServer(server);
    }
  });

  it("取消活动 Adapter 后等待关键尾部静止，再释放 Workspace Lease", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-lease-cancel-"));
    const server = createWriteCallingServer("slow_write");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    let adapterEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      adapterEntered = resolve;
    });
    const slowTool: CoreMindToolDefinition = {
      name: "slow_write",
      description: "等待取消的写入工具",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
      capability: {
        effect: "workspace",
        replay: "idempotent",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
      },
      execute: async (_args, context) => {
        adapterEntered();
        await new Promise<never>((_resolve, reject) => {
          if (context.signal?.aborted) {
            reject(new Error("cancelled"));
            return;
          }
          context.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      },
    };

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {}),
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        approveTool: async () => "allow",
        runStore: new FileRunStore(path.join(dir, "runs")),
        toolDefinitions: [slowTool],
        signal: controller.signal,
      });

      const run = runtime.run();
      await entered;
      expect(await new WorkspaceLeaseService().inspect(dir)).toMatchObject({ state: "held" });
      controller.abort();
      const result = await run;

      expect(result.outcome.status).toBe("aborted");
      expect(await new WorkspaceLeaseService().inspect(dir)).toMatchObject({ state: "available" });
    } finally {
      await closeServer(server);
    }
  });

  it("持久 Cancel Control 与 Runtime Facts 共用单调 writer，并收敛到 aborted", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-control-cancel-"));
    const server = createWriteCallingServer("slow_write");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const store = new FileRunStore(path.join(dir, "runs"));
    const events: CoreMindEvent[] = [];
    let adapterEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      adapterEntered = resolve;
    });
    const slowTool: CoreMindToolDefinition = {
      name: "slow_write",
      description: "等待持久控制取消的写入工具",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
      capability: {
        effect: "workspace",
        replay: "idempotent",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
      },
      execute: async (_args, context) => {
        adapterEntered();
        await new Promise<never>((_resolve, reject) => {
          if (context.signal?.aborted) {
            reject(new Error("cancelled"));
            return;
          }
          context.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        });
      },
    };

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {}),
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        runId: "control-cancel-run",
        approveTool: async () => "allow",
        runStore: store,
        toolDefinitions: [slowTool],
        events: (event) => events.push(event),
        signal: controller.signal,
        applyControl: async (command) => {
          if (command.type !== "cancel") return { status: "rejected", reason: "测试只接受 cancel" };
          return { status: "applied", afterDurable: () => controller.abort() };
        },
      });

      const run = runtime.run();
      await entered;
      const receipt = await runtime.acceptControl({
        schemaVersion: 1,
        controlId: "cancel-1",
        runId: "control-cancel-run",
        type: "cancel",
        reason: "用户停止",
      });
      const result = await run;
      const records = await store.read("control-cancel-run");
      const controls = records.filter((record) => record.kind === "control");

      expect({
        receipt,
        outcome: result.outcome.status,
        quiescent: await runtime.waitForQuiescence(100),
        workspaceLease: await new WorkspaceLeaseService().inspect(dir),
        quiescenceTimeouts: events.filter((event) => event.type === "quiescence_timeout"),
        controls,
        sequences: records.map((item) => item.sequence),
      }).toEqual({
        receipt: {
          schemaVersion: 1,
          controlId: "cancel-1",
          runId: "control-cancel-run",
          status: "applied",
          appliedSequence: controls[1]?.sequence,
        },
        outcome: "aborted",
        quiescent: true,
        workspaceLease: expect.objectContaining({ state: "available" }),
        quiescenceTimeouts: [],
        controls: [
          expect.objectContaining({
            kind: "control",
            payload: expect.objectContaining({ controlId: "cancel-1", state: "accepted" }),
          }),
          expect.objectContaining({
            kind: "control",
            payload: expect.objectContaining({ controlId: "cancel-1", state: "applied" }),
          }),
        ],
        sequences: records.map((_item, index) => index + 1),
      });
    } finally {
      controller.abort();
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("两个 Runtime 同时写同一 Workspace 时最多一个进入 Adapter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-lease-two-runs-"));
    const firstServer = createWriteCallingServer("held_write");
    const secondServer = createWriteCallingServer();
    await Promise.all([
      new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve)),
    ]);
    let adapterEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      adapterEntered = resolve;
    });
    let releaseAdapter!: () => void;
    const adapterReleased = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    const heldTool: CoreMindToolDefinition = {
      name: "held_write",
      description: "用于双 Runtime 竞争测试的写工具",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
      capability: {
        effect: "workspace",
        replay: "idempotent",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
      },
      execute: async () => {
        adapterEntered();
        await adapterReleased;
        return { text: "first done" };
      },
    };

    try {
      const first = await CoreMindRuntime.create({
        config: toolConfig((firstServer.address() as AddressInfo).port, {}),
        configDir: dir,
        cwd: dir,
        initialPrompt: "执行 held_write",
        approveTool: async () => "allow",
        runStore: new FileRunStore(path.join(dir, "runs-first")),
        toolDefinitions: [heldTool],
      });
      const second = await CoreMindRuntime.create({
        config: {
          ...toolConfig((secondServer.address() as AddressInfo).port, {}),
          tools: [{ id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        approveTool: async () => "allow",
        runStore: new FileRunStore(path.join(dir, "runs-second")),
      });

      const firstRun = first.run();
      await entered;
      const secondResult = await second.run();

      expect(secondResult.outcome).toMatchObject({
        status: "failed",
        error: { code: "workspace_busy" },
      });
      expect(secondResult.trace.every((entry) => entry.runId === secondResult.runId)).toBe(true);
      expect(existsSync(path.join(dir, "article.md"))).toBe(false);
      releaseAdapter();
      const firstResult = await firstRun;
      expect(firstResult.outcome.status).toBe("succeeded");
      expect(firstResult.runId).not.toBe(secondResult.runId);
      expect(firstResult.trace.every((entry) => entry.runId === firstResult.runId)).toBe(true);
      expect(await new WorkspaceLeaseService().inspect(dir)).toMatchObject({ state: "available" });
    } finally {
      releaseAdapter();
      await Promise.all([closeServer(firstServer), closeServer(secondServer)]);
    }
  });

  it("用户审批 Fact 无法达到 critical 时，Pure Local Read 也不能越过 Adapter 前门禁", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-approval-durability-"));
    writeFileSync(path.join(dir, "notes.txt"), "不应读取", "utf8");
    const server = createToolCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {
          permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt",
        approveTool: async () => "allow",
        runStore: new MemoryRunStore(),
      });

      const result = await runtime.run();
      const lifecycle = result.trace
        .filter((entry) => entry.event.type === "tool_lifecycle")
        .map((entry) =>
          entry.event.type === "tool_lifecycle" ? entry.event.resolution : undefined,
        );

      expect(lifecycle).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "executing", status: "skipped" }),
          expect.objectContaining({
            phase: "observed",
            result: expect.objectContaining({
              executionOutcome: "not_invoked",
              effectState: "not_started",
            }),
          }),
        ]),
      );
      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "durability_unsupported" },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("仅最终 pause/finish barrier 失败时返回结构化持久化失败，而不是 reject", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-terminal-barrier-"));
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new FileRunStore(path.join(dir, "runs"), {
      beforeBarrier: ({ record }) => {
        if (record?.kind === "finish") throw new Error("terminal barrier failed");
      },
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "终态 Barrier 测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "完成任务" } },
        },
        configDir: dir,
        initialPrompt: "完成",
        runStore: store,
      });

      const result = await runtime.run();
      expect(result).toMatchObject({
        outcome: {
          status: "failed",
          error: { code: "durability_barrier_failed" },
        },
      });
      const records = await store.read(result.runId);
      const finishes = records.filter((record) => record.kind === "finish");
      expect(finishes).toEqual([]);
      expect(
        checkInvariantFacts({ runRecords: records }, { mode: "eval" }).filter(
          (violation) => violation.invariant === "I-3",
        ),
      ).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("Store 不支持 critical 时副作用工具在 Adapter 前失败关闭", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-durability-unsupported-"));
    const target = path.join(dir, "article.md");
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            permissions: { mode: "full", workspaceOnly: true, network: "deny" },
          }),
          tools: [{ id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        runStore: new MemoryRunStore(),
      });

      const result = await runtime.run();

      expect(existsSync(target)).toBe(false);
      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "durability_unsupported" },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("started_durable barrier 失败时真实 Effect 次数为零", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-started-barrier-"));
    const target = path.join(dir, "article.md");
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new FileRunStore(path.join(dir, "runs"), {
      beforeBarrier: ({ record }) => {
        const payload = record?.payload as
          | { event?: { type?: string; status?: string } }
          | undefined;
        if (payload?.event?.type === "effect_receipt" && payload.event.status === "started") {
          throw new Error("started barrier failed");
        }
      },
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            permissions: { mode: "full", workspaceOnly: true, network: "deny" },
          }),
          tools: [{ id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        runStore: store,
      });

      const result = await runtime.run();
      const lifecycle = result.trace
        .filter((entry) => entry.event.type === "tool_lifecycle")
        .map((entry) =>
          entry.event.type === "tool_lifecycle" ? entry.event.resolution : undefined,
        );

      expect(existsSync(target)).toBe(false);
      expect(lifecycle).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: "checkpoint_durable", status: "completed" }),
          expect.objectContaining({ phase: "started_durable", status: "failed" }),
        ]),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("started Receipt 在 critical acknowledgement 完成前不可见为可执行", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-started-pending-"));
    const target = path.join(dir, "article.md");
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let barrierEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      barrierEntered = resolve;
    });
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const store = new FileRunStore(path.join(dir, "runs"), {
      beforeBarrier: async ({ record }) => {
        const payload = record?.payload as
          | { event?: { type?: string; status?: string } }
          | undefined;
        if (payload?.event?.type === "effect_receipt" && payload.event.status === "started") {
          barrierEntered();
          await acknowledgement;
        }
      },
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            permissions: { mode: "full", workspaceOnly: true, network: "deny" },
          }),
          tools: [{ id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        runStore: store,
      });

      const run = runtime.run();
      await entered;
      expect(existsSync(target)).toBe(false);
      acknowledge();
      const result = await run;

      expect(readFileSync(target, "utf8")).toBe("已写入");
      expect(result.outcome.status).toBe("succeeded");
    } finally {
      acknowledge?.();
      await closeServer(server);
    }
  });

  it("Tool 返回后 result barrier 失败保留执行与 Effect 事实，只把持久化标为失败", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-result-barrier-"));
    const target = path.join(dir, "article.md");
    const server = createWriteCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new FileRunStore(path.join(dir, "runs"), {
      beforeBarrier: ({ record }) => {
        const payload = record?.payload as { event?: { type?: string } } | undefined;
        if (payload?.event?.type === "tool_result") throw new Error("result barrier failed");
      },
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            permissions: { mode: "full", workspaceOnly: true, network: "deny" },
          }),
          tools: [{ id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "写入 article.md",
        runStore: store,
      });

      const result = await runtime.run();
      const lifecycle = result.trace.filter((entry) => entry.event.type === "tool_lifecycle");
      const failedPersistence = lifecycle.find(
        (entry) =>
          entry.event.type === "tool_lifecycle" &&
          entry.event.resolution.phase === "result_durable",
      )?.event;

      expect(readFileSync(target, "utf8")).toBe("已写入");
      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "durability_barrier_failed" },
      });
      expect(failedPersistence).toMatchObject({
        type: "tool_lifecycle",
        resolution: {
          phase: "result_durable",
          status: "failed",
          result: { persistenceState: "failed" },
        },
      });
      expect(
        lifecycle.some(
          (entry) =>
            entry.event.type === "tool_lifecycle" &&
            entry.event.resolution.phase === "observed" &&
            entry.event.resolution.result?.executionOutcome === "returned" &&
            entry.event.resolution.result.effectState === "committed",
        ),
      ).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("成功运行返回分离的结果、指标、评测、发布就绪度和结构化 Trace", async () => {
    const server = createServer((_request, response) => {
      sendSse(response, [
        {
          id: "success",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "完成" },
              finish_reason: null,
            },
          ],
        },
        { id: "success", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-result-"));
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "结果模型测试",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        agents: { main: { systemPrompt: "测试助手" } },
      };
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: dir,
        initialPrompt: "执行",
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({ status: "succeeded", finishReason: "completed" });
      expect(result.operation).toMatchObject({
        runId: result.runId,
        state: "completed",
        transitionSequence: 3,
      });
      expect(result.metrics).toMatchObject({ turns: 1, toolCalls: 0, toolFailures: 0 });
      expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.evaluation.profile).toBe("standard");
      expect(result.releaseReadiness.ready).toBe(false);
      expect(result.releaseReadiness.blockers).toContain("尚未执行场景评测");
      expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.trace.length).toBeGreaterThan(0);
      expect(result.trace.every((entry) => entry.runId === result.runId)).toBe(true);
      expect(result.trace.map((entry) => entry.sequence)).toEqual(
        result.trace.map((_entry, index) => index + 1),
      );
      expect(result.trace.every((entry) => !Number.isNaN(Date.parse(entry.timestamp)))).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("模型执行失败时向调用方报告失败", async () => {
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "失败语义测试",
      provider: {
        id: "probe",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "probe-model",
        apiKey: "test-key",
      },
      agents: {
        main: { systemPrompt: "测试助手" },
      },
    };
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: mkdtempSync(path.join(tmpdir(), "coremind-runtime-failure-")),
      initialPrompt: "触发模型错误",
      env: {},
    });

    const result = await runtime.run();

    expect(result.outcome).toMatchObject({
      status: "failed",
      finishReason: "provider_transient",
      error: { code: "provider_transient" },
    });
  });

  it("工作流步骤的模型失败时向调用方报告失败", async () => {
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "工作流失败语义测试",
      provider: {
        id: "probe",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "probe-model",
        apiKey: "test-key",
      },
      agents: {
        main: { systemPrompt: "测试助手" },
      },
      workflow: [{ id: "s1", type: "prompt", agent: "main", input: "触发模型错误" }],
    };
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: mkdtempSync(path.join(tmpdir(), "coremind-workflow-failure-")),
      env: {},
    });

    const result = await runtime.run();

    expect(result.outcome).toMatchObject({
      status: "failed",
      finishReason: "provider_transient",
      error: { code: "provider_transient" },
    });
  });

  it("未知 Provider 错误不重试，暂停并把脱敏审计值写入终态 Fact", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-provider-unclassified-"));
    const store = new FileRunStore(path.join(dir, "runs"));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "vendor_private_error",
            message: "Bearer provider-secret token=provider-secret",
          },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, { runtime: { maxRetries: 3 } }),
          tools: [],
        },
        configDir: dir,
        initialPrompt: "触发未知 Provider 错误",
        runStore: store,
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);
      const terminal = records.at(-1);

      expect(requests).toBe(1);
      expect(result.metrics.retries).toBe(0);
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "unclassified_error",
        error: {
          code: "unclassified_error",
          audit: { originalCode: expect.any(String) },
        },
      });
      expect(JSON.stringify(result.outcome)).not.toContain("provider-secret");
      expect(terminal).toMatchObject({
        kind: "pause",
        payload: { outcome: result.outcome },
      });
      expect(ProjectionEngine.project(records).recovery).toMatchObject({
        resumable: false,
        requiresHuman: true,
      });
      const resumed = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, { runtime: { maxRetries: 3 } }),
          tools: [],
        },
        configDir: dir,
        initialPrompt: "触发未知 Provider 错误",
        runStore: store,
        resumeRunId: result.runId,
      });
      await expect(resumed.run()).rejects.toMatchObject({ code: "unclassified_error" });
      expect(requests).toBe(1);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未知 Tool Adapter 异常只产生一次副作用并暂停等待人工审计", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-tool-unclassified-"));
    const effectMarker = path.join(dir, "effects.log");
    const store = new FileRunStore(path.join(dir, "runs"));
    const server = createWriteCallingServer("unstable_write");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const unstableTool: CoreMindToolDefinition = {
      name: "unstable_write",
      description: "产生一次副作用后返回未知 Adapter 错误",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
      capability: {
        effect: "workspace",
        replay: "idempotent",
        concurrency: "workspace_exclusive",
        checkpoint: "required",
        durability: "critical",
      },
      execute: async () => {
        appendFileSync(effectMarker, "effect\n", "utf8");
        throw Object.assign(new Error("Bearer tool-secret"), {
          code: "vendor_tool_error?token=tool-secret",
        });
      },
    };
    try {
      const runtime = await CoreMindRuntime.create({
        config: toolConfig((server.address() as AddressInfo).port, {
          runtime: { maxRetries: 3, maxToolFailures: 0 },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "调用写入工具",
        approveTool: async () => "allow",
        runStore: store,
        toolDefinitions: [unstableTool],
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);

      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "unclassified_error",
        error: {
          code: "unclassified_error",
          audit: { originalCode: "vendor_tool_error?token=hidden" },
        },
      });
      expect(readFileSync(effectMarker, "utf8").trim().split("\n")).toEqual(["effect"]);
      expect(result.metrics.retries).toBe(0);
      expect(JSON.stringify(records)).not.toContain("tool-secret");
      expect(ProjectionEngine.project(records).recovery).toMatchObject({
        resumable: false,
        requiresHuman: true,
      });
      const resumed = await CoreMindRuntime.create({
        config: toolConfig((server.address() as AddressInfo).port, {
          runtime: { maxRetries: 3, maxToolFailures: 0 },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "调用写入工具",
        approveTool: async () => "allow",
        runStore: store,
        toolDefinitions: [unstableTool],
        resumeRunId: result.runId,
      });
      await expect(resumed.run()).rejects.toMatchObject({ code: "unclassified_error" });
      expect(readFileSync(effectMarker, "utf8").trim().split("\n")).toEqual(["effect"]);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("并行 Tool 同时失败时按稳定 Call 标识选择终态", async () => {
    const runWithDelays = async (alphaDelayMs: number, betaDelayMs: number) => {
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-parallel-tool-failures-"));
      const server = createParallelFailingToolServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const attempts: string[] = [];
      const failingTool = (name: string, delayMs: number): CoreMindToolDefinition => ({
        name,
        description: `${name} 并行失败探针`,
        parameters: { type: "object", properties: {} },
        effect: { operations: ["read"], reversible: true },
        capability: {
          effect: "none",
          replay: "safe",
          concurrency: "parallel",
          checkpoint: "none",
          durability: "ordinary",
        },
        execute: async () => {
          attempts.push(name);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          throw Object.assign(new Error(`${name} failed`), { code: `vendor_${name}` });
        },
      });
      try {
        const runtime = await CoreMindRuntime.create({
          config: toolConfig((server.address() as AddressInfo).port, {
            runtime: { maxRetries: 3 },
          }),
          configDir: dir,
          cwd: dir,
          initialPrompt: "并行调用两个工具",
          approveTool: async () => "allow",
          toolDefinitions: [failingTool("alpha", alphaDelayMs), failingTool("beta", betaDelayMs)],
        });

        const result = await runtime.run();
        return { outcome: result.outcome, attempts: [...attempts].sort() };
      } finally {
        await closeServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    };

    const alphaFinishesLast = await runWithDelays(25, 0);
    const alphaFinishesFirst = await runWithDelays(0, 25);

    for (const result of [alphaFinishesLast, alphaFinishesFirst]) {
      expect(result.attempts).toEqual(["alpha", "beta"]);
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "unclassified_error",
        error: {
          code: "unclassified_error",
          audit: { originalCode: "vendor_alpha" },
        },
      });
    }
  });

  it("质量统计包含调用方收到的工具事件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-tools-"));
    writeFileSync(path.join(dir, "notes.txt"), "测试内容", "utf8");
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const messages =
          (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages ?? [];
        if (messages.some((message) => message.role === "tool")) {
          sendSse(response, [
            {
              id: "final",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "读取完成" },
                  finish_reason: null,
                },
              ],
            },
            { id: "final", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
          return;
        }
        sendSse(response, [
          {
            id: "tool",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-read",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"notes.txt"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "工具统计测试",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        tools: [{ id: "read" }],
        agents: {
          main: { systemPrompt: "按要求调用工具" },
        },
      };
      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt",
        events: (event) => events.push(event),
      });

      const result = await runtime.run();

      expect(events.some((event) => event.type === "tool_call")).toBe(true);
      expect(result.metrics.toolCalls).toBe(1);
      const capabilityFacts = result.trace.filter(
        (entry) => entry.event.type === "capability_resolved",
      );
      expect(capabilityFacts).toHaveLength(1);
      expect(capabilityFacts[0]?.event).toMatchObject({
        type: "capability_resolved",
        agent: "main",
        tool: "read",
        callId: "call-read",
        capability: {
          effect: "none",
          replay: "safe",
          concurrency: "parallel",
          checkpoint: "none",
          durability: "ordinary",
          source: "builtin",
          resolution: "resolved",
        },
        recoveryDisposition: "replay_safe",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("同一 CallId 更换工具时在执行前失败关闭", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-capability-conflict-"));
    writeFileSync(path.join(dir, "notes.txt"), "只读内容", "utf8");
    const target = path.join(dir, "conflict.txt");
    let providerRequests = 0;
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.resume();
      request.on("end", () => {
        providerRequests += 1;
        if (providerRequests > 2) {
          sendSse(response, [
            {
              id: "final",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "不应到达" },
                  finish_reason: null,
                },
              ],
            },
            { id: "final", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
          return;
        }
        const firstCall = providerRequests === 1;
        sendSse(response, [
          {
            id: "conflicting-tools",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "shared-call",
                      type: "function",
                      function: firstCall
                        ? { name: "read", arguments: '{"path":"notes.txt"}' }
                        : {
                            name: "write",
                            arguments: '{"path":"conflict.txt","content":"不应写入"}',
                          },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            id: "conflicting-tools",
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          },
        ]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "Capability Call 冲突测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          tools: [{ id: "read" }, { id: "write" }],
          agents: { main: { systemPrompt: "按要求调用工具" } },
          permissions: { mode: "full", workspaceOnly: true, network: "deny" },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "执行两个工具",
      });

      const result = await runtime.run();

      expect(
        result.trace
          .filter((entry) => entry.event.type === "tool_call")
          .map((entry) =>
            entry.event.type === "tool_call"
              ? { callId: entry.event.callId, tool: entry.event.tool }
              : undefined,
          ),
      ).toEqual([
        { callId: "shared-call", tool: "read" },
        { callId: "shared-call", tool: "write" },
      ]);
      expect(result.outcome).toMatchObject({ status: "failed" });
      expect(existsSync(target)).toBe(false);
      expect(result.trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({
              type: "error",
              message: expect.stringContaining("Tool Capability"),
            }),
          }),
        ]),
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("达到工具调用预算后以 budget_exceeded 失败，而不是继续运行", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-budget-"));
    writeFileSync(path.join(dir, "notes.txt"), "预算测试", "utf8");
    const server = createToolCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {
          runtime: { maxToolCalls: 0 },
          permissions: { mode: "full", workspaceOnly: true, network: "ask" },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt",
      });

      const result = await runtime.run();

      expect(result.outcome).toEqual({
        status: "budget_exceeded",
        finishReason: "budget_exceeded",
        error: {
          code: "budget_exceeded",
          message: "工具调用次数超过上限（0 次）",
        },
      });
      expect(result.releaseReadiness.ready).toBe(false);
      expect(
        result.trace
          .filter((entry) => entry.event.type === "tool_lifecycle")
          .map((entry) => {
            const resolution = (entry.event as { resolution: { phase: string; status: string } })
              .resolution;
            return `${resolution.phase}:${resolution.status}`;
          }),
      ).toEqual([
        "call_recorded:completed",
        "capability_resolved:completed",
        "policy_resolved:skipped",
        "approval_resolved:skipped",
        "lease_acquired:skipped",
        "checkpoint_durable:skipped",
        "started_durable:skipped",
        "executing:skipped",
        "observed:skipped",
        "result_durable:completed",
        "terminal:completed",
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("ask 模式通过调用方批准后执行工具并记录审批 Trace", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-approval-"));
    writeFileSync(path.join(dir, "notes.txt"), "审批测试", "utf8");
    const server = createToolCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const approvals: string[] = [];

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {
          permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt",
        approveTool: async (request) => {
          approvals.push(request.tool);
          return "allow";
        },
      });

      const result = await runtime.run();

      expect(approvals).toEqual(["read"]);
      expect(result.metrics.toolCalls).toBe(1);
      expect(result.trace.some((entry) => entry.event.type === "approval_required")).toBe(true);
      expect(result.trace.some((entry) => entry.event.type === "approval_resolved")).toBe(true);
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "tool_call" &&
            entry.event.idempotencyKey === `${result.runId}:call-read`,
        ),
      ).toBe(true);
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "tool_result" &&
            entry.event.idempotencyKey === `${result.runId}:call-read`,
        ),
      ).toBe(true);
      const receiptEvents = result.trace
        .filter((entry) => entry.event.type === "effect_receipt")
        .map((entry) => entry.event);
      expect(receiptEvents.map((event) => event.status)).toEqual(["started", "committed"]);
      expect(receiptEvents.map((event) => event.binding)).toEqual([
        expect.objectContaining({
          version: 1,
          runId: result.runId,
          agent: "main",
          callId: "call-read",
          tool: "read",
          argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          capabilityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
        expect.objectContaining({
          version: 1,
          runId: result.runId,
          agent: "main",
          callId: "call-read",
          tool: "read",
          argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          capabilityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      ]);
      expect(receiptEvents[1]?.binding).toEqual(receiptEvents[0]?.binding);
      expect(
        result.trace
          .filter((entry) => entry.event.type === "tool_lifecycle")
          .map((entry) => {
            const resolution = (entry.event as { resolution: { phase: string; status: string } })
              .resolution;
            return `${resolution.phase}:${resolution.status}`;
          }),
      ).toEqual([
        "call_recorded:completed",
        "capability_resolved:completed",
        "policy_resolved:completed",
        "approval_resolved:completed",
        "lease_acquired:skipped",
        "checkpoint_durable:skipped",
        "started_durable:skipped",
        "executing:completed",
        "observed:completed",
        "result_durable:completed",
        "terminal:completed",
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("Turn 身份：工具执行归属刚结束的 Turn，下一轮开启新 Turn", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-turn-"));
    writeFileSync(path.join(dir, "notes.txt"), "turn 测试", "utf8");
    const server = createToolCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {
          permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt",
        approveTool: async () => "allow",
      });

      const result = await runtime.run();

      const agentStart = result.trace.find((entry) => entry.event.type === "agent_start");
      const turnEnds = result.trace.filter((entry) => entry.event.type === "turn_end");
      const withTurnId = (type: string) =>
        result.trace
          .filter((entry) => entry.event.type === type)
          .map((entry) => (entry.event as { turnId?: string }).turnId);

      expect(agentStart?.event.turnId).toBeDefined();
      // 两轮模型请求（工具调用 + 最终回复）产生两个不同 Turn
      expect(turnEnds).toHaveLength(2);
      expect(turnEnds[1]?.event.turnId).not.toBe(turnEnds[0]?.event.turnId);
      // 工具执行归属第一轮刚结束的 Turn
      const firstTurnId = turnEnds[0]?.event.turnId;
      for (const turnId of withTurnId("tool_call")) expect(turnId).toBe(firstTurnId);
      for (const turnId of withTurnId("tool_result")) expect(turnId).toBe(firstTurnId);
      for (const turnId of withTurnId("effect_receipt")) expect(turnId).toBe(firstTurnId);
    } finally {
      await closeServer(server);
    }
  });

  it("ask 模式全部工具请求被拒绝时返回暂停而不是成功", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-denied-"));
    writeFileSync(path.join(dir, "notes.txt"), "审批拒绝测试", "utf8");
    const server = createToolCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const store = new FileRunStore(path.join(dir, "runs"));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {
          permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "必须读取 notes.txt 才能完成任务",
        approveTool: async () => "deny",
        runStore: store,
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
      expect(result.trace.filter((entry) => entry.event.type === "approval_required")).toHaveLength(
        1,
      );
      expect(
        result.trace.filter(
          (entry) => entry.event.type === "approval_resolved" && entry.event.decision === "deny",
        ),
      ).toHaveLength(1);
      expect(result.trace.filter((entry) => entry.event.type === "turn_end")).toHaveLength(1);
      expect(result.operation).toMatchObject({
        state: "paused",
        pauseReason: "tool_approval_denied",
      });
      expect(result.trace.some((entry) => entry.event.type === "policy_denied")).toBe(true);
      expect(result.releaseReadiness.ready).toBe(false);
      expect(result.snapshot.resumable).toBe(true);
      expect(
        result.trace
          .filter((entry) => entry.event.type === "tool_lifecycle")
          .map((entry) => {
            const resolution = (entry.event as { resolution: { phase: string; status: string } })
              .resolution;
            return `${resolution.phase}:${resolution.status}`;
          }),
      ).toEqual([
        "call_recorded:completed",
        "capability_resolved:completed",
        "policy_resolved:completed",
        "approval_resolved:completed",
        "lease_acquired:skipped",
        "checkpoint_durable:skipped",
        "started_durable:skipped",
        "executing:skipped",
        "observed:skipped",
        "result_durable:completed",
        "terminal:completed",
      ]);
      const records = await store.read(result.runId);
      expect(() =>
        prepareRunResume(
          records,
          fingerprintRunConfig(
            toolConfig(port, {
              permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
            }),
          ),
        ),
      ).not.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it("人工拒绝第一次工具审批后立即停止，不再次请求模型或审批", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-denied-stop-"));
    const target = path.join(dir, "article.md");
    writeFileSync(path.join(dir, "notes.txt"), "不应触发第二次审批", "utf8");
    let providerRequests = 0;
    const server = createServer((_request, response) => {
      providerRequests += 1;
      sendSse(response, [
        {
          id: `tool-${providerRequests}`,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-read-${providerRequests}`,
                    type: "function",
                    function: {
                      name: "write",
                      arguments: '{"path":"article.md","content":"不应写入"}',
                    },
                  },
                  {
                    index: 1,
                    id: `call-read-${providerRequests}`,
                    type: "function",
                    function: { name: "read", arguments: '{"path":"notes.txt"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: `tool-${providerRequests}`,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let approvals = 0;
    const store = new FileRunStore(path.join(dir, "runs"));

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            runtime: { maxTurns: 3 },
            permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
          }),
          tools: [{ id: "write" }, { id: "read" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "必须写入 article.md 才能完成任务",
        approveTool: async () => {
          approvals += 1;
          return "deny";
        },
        runStore: store,
      });

      const result = await runtime.run();

      expect(providerRequests).toBe(1);
      expect(approvals).toBe(1);
      expect(existsSync(target)).toBe(false);
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
      const receiptStatuses = result.trace
        .filter((entry) => entry.event.type === "effect_receipt")
        .map((entry) => entry.event.status);
      expect(receiptStatuses.length).toBeGreaterThan(0);
      expect(receiptStatuses.every((status) => status === "not_started")).toBe(true);
      const resumeConfig: CoreMindConfig = {
        ...toolConfig(port, {
          runtime: { maxTurns: 3 },
          permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
        }),
        tools: [{ id: "write" }, { id: "read" }],
      };
      const records = await store.read(result.runId);
      expect(() => prepareRunResume(records, fingerprintRunConfig(resumeConfig))).not.toThrow();
    } finally {
      await closeServer(server);
    }
  });

  it("同批次先允许后拒绝时在批次结束后停止，不再请求模型", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-mixed-denial-stop-"));
    const target = path.join(dir, "article.md");
    writeFileSync(path.join(dir, "notes.txt"), "允许读取的内容", "utf8");
    let providerRequests = 0;
    const server = createServer((_request, response) => {
      providerRequests += 1;
      sendSse(response, [
        {
          id: `mixed-tool-${providerRequests}`,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-read-${providerRequests}`,
                    type: "function",
                    function: { name: "read", arguments: '{"path":"notes.txt"}' },
                  },
                  {
                    index: 1,
                    id: `call-write-${providerRequests}`,
                    type: "function",
                    function: {
                      name: "write",
                      arguments: '{"path":"article.md","content":"不应写入"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: `mixed-tool-${providerRequests}`,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const approvals: string[] = [];

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            runtime: { maxTurns: 3 },
            permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
          }),
          tools: [{ id: "read" }, { id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt，但不要写入 article.md",
        approveTool: async (request) => {
          approvals.push(request.tool);
          return request.tool === "read" ? "allow" : "deny";
        },
      });

      const result = await runtime.run();

      expect(providerRequests).toBe(1);
      expect(approvals).toEqual(["read", "write"]);
      expect(existsSync(target)).toBe(false);
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("工作流步骤的工具审批被拒绝后立即暂停，不执行后续步骤", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-workflow-denied-stop-"));
    const target = path.join(dir, "article.md");
    let providerRequests = 0;
    const server = createServer((_request, response) => {
      providerRequests += 1;
      sendSse(response, [
        {
          id: `workflow-denied-${providerRequests}`,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call-write-${providerRequests}`,
                    type: "function",
                    function: {
                      name: "write",
                      arguments: '{"path":"article.md","content":"不应写入"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: `workflow-denied-${providerRequests}`,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let approvals = 0;

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            runtime: { maxTurns: 3 },
            permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
          }),
          tools: [{ id: "write" }],
          workflow: [
            {
              id: "write-article",
              type: "prompt",
              agent: "main",
              input: "写入 article.md",
              saveAs: "article",
            },
            {
              id: "continue-after-denial",
              type: "prompt",
              agent: "main",
              input: "不得执行的后续步骤",
              saveAs: "later",
            },
          ],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "验证工作流拒绝边界",
        approveTool: async () => {
          approvals += 1;
          return "deny";
        },
      });

      const result = await runtime.run();

      expect(providerRequests).toBe(1);
      expect(approvals).toBe(1);
      expect(existsSync(target)).toBe(false);
      expect(result.outputs.has("article")).toBe(false);
      expect(result.outputs.has("later")).toBe(false);
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "step_end" &&
            entry.event.stepId === "write-article" &&
            entry.event.ok === false,
        ),
      ).toBe(true);
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "step_start" && entry.event.stepId === "continue-after-denial",
        ),
      ).toBe(false);
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("总运行超时会中止单 Agent 并返回 run_timeout", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "late",
              choices: [
                { index: 0, delta: { role: "assistant", content: "太晚" }, finish_reason: null },
              ],
            },
            { id: "late", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 100);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-timeout-"));
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "超时测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
          runtime: { runTimeoutMs: 10 },
        },
        configDir: dir,
        initialPrompt: "执行",
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({
        status: "timeout",
        finishReason: "run_timeout",
        error: { code: "run_timeout" },
      });
      expect(result.operation).toMatchObject({ state: "failed", failureReason: "run_timeout" });
      expect(result.releaseReadiness.ready).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("会话文件损坏时明确报告恢复失败", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-session-corrupt-"));
    writeFileSync(path.join(dir, "broken.jsonl"), "{不是有效的会话记录", "utf8");
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "会话恢复测试",
      agents: { main: { systemPrompt: "测试助手" } },
      session: { enabled: true, dir },
    };

    await expect(
      CoreMindRuntime.create({ config, configDir: dir, sessionId: "broken" }),
    ).rejects.toMatchObject({ code: "session_restore_failed" });
  });

  it("session.dir 缺省时写入配置目录下 sessions，而不是配置根目录", async () => {
    const server = createServer((_request, response) => {
      sendSse(response, [
        {
          id: "session",
          choices: [
            { index: 0, delta: { role: "assistant", content: "已保存" }, finish_reason: null },
          ],
        },
        { id: "session", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-session-default-dir-"));
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "会话默认目录测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        initialPrompt: "保存",
        sessionId: "s1",
      });

      const result = await runtime.run();

      expect(result.sessionFile).toBe(path.join(dir, "sessions", "s1.jsonl"));
    } finally {
      await closeServer(server);
    }
  });

  it("从中断 RunState 的稳定工作流边界继续执行", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      sendSse(response, [
        {
          id: "resume",
          choices: [
            { index: 0, delta: { role: "assistant", content: "第二步完成" }, finish_reason: null },
          ],
        },
        { id: "resume", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "恢复测试",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        agents: { main: { systemPrompt: "测试助手" } },
        workflow: [
          { id: "s1", type: "prompt", agent: "main", input: "第一步", saveAs: "first" },
          {
            id: "s2",
            type: "prompt",
            agent: "main",
            input: "继续 {{first.text}}",
            saveAs: "second",
          },
        ],
      };
      const runStateDir = mkdtempSync(path.join(tmpdir(), "coremind-run-resume-state-"));
      const store = new FileRunStore(runStateDir);
      const journal = new RunStateJournal("resume-run", store);
      await journal.start({
        configFingerprint: fingerprintRunConfig(config),
        initialPrompt: "开始",
      });
      journal.event({
        eventId: "stable-output",
        runId: "resume-run",
        sequence: 1,
        timestamp: new Date().toISOString(),
        event: {
          type: "step_output",
          stepId: "s1",
          agent: "main",
          text: "第一步已完成",
          saveAs: "first",
        },
      });
      await journal.flush();
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-resume-"));
      const resumeConfig: CoreMindConfig = {
        ...config,
        telemetry: {
          mode: "FULL",
          endpoint: "https://telemetry.example/v1/traces",
          contentLevel: "metrics_only",
          allowedFields: [],
        },
      };
      const runtime = await CoreMindRuntime.create({
        config: resumeConfig,
        configDir: dir,
        initialPrompt: "开始",
        resumeRunId: "resume-run",
        runStore: store,
      });

      const result = await runtime.run();

      expect(result.runId).toBe("resume-run");
      expect(requests).toBe(1);
      expect(result.outputs.get("first")?.text).toBe("第一步已完成");
      expect(result.outputs.get("second")?.text).toContain("第二步完成");
      expect(result.trace.some((entry) => entry.event.type === "step_resumed")).toBe(true);
      const resumedFacts = await store.read("resume-run");
      expect(resumedFacts.at(-1)?.kind).toBe("finish");
      expect(
        resumedFacts.find((fact) => fact.kind === "telemetry_configuration")?.payload,
      ).toMatchObject({
        schemaVersion: 1,
        mode: "FULL",
        endpointOrigin: "https://telemetry.example",
      });
      expect(result.observability.telemetry).toMatchObject({
        mode: "FULL",
        lastFailure: "exporter_unavailable",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("显式 Loop 只有在修复后再次验证通过才返回成功", async () => {
    const server = createTextSequenceServer(["candidate-a", "FAIL", "candidate-b", "PASS"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: loopConfig(port),
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-loop-success-")),
        initialPrompt: "修复缺陷",
        events: (event) => events.push(event),
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({ status: "succeeded", finishReason: "completed" });
      expect(result.transcript).toBe("candidate-b");
      expect(result.outputs.get("candidate")?.text).toBe("candidate-b");
      expect(
        events.filter((event) => event.type === "loop_state").map((event) => event.to),
      ).toEqual(["executing", "verifying", "repairing", "verifying", "succeeded"]);
    } finally {
      await closeServer(server);
    }
  });

  it("TUI/readline 使用的 runAgentTurn 观察到同一 Loop 状态序列", async () => {
    const server = createTextSequenceServer(["candidate-a", "FAIL", "candidate-b", "PASS"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-loop-chat-"));
      const runtime = await CoreMindRuntime.create({ config: loopConfig(port), configDir: dir });
      const events: CoreMindEvent[] = [];

      const result = await runtime.runAgentTurn("coder", "修复缺陷", [], (event) =>
        events.push(event),
      );

      expect(result.outcome.status).toBe("succeeded");
      expect(result.transcript).toBe("candidate-b");
      expect(
        events.filter((event) => event.type === "loop_state").map((event) => event.to),
      ).toEqual(["executing", "verifying", "repairing", "verifying", "succeeded"]);
    } finally {
      await closeServer(server);
    }
  });

  it("Loop 暂停后从稳定快照继续，不重复执行已完成步骤", async () => {
    const server = createTextSequenceServer(["candidate-a", "FAIL", "candidate-b", "PASS"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const config = loopConfig(port, { onFailure: "pause" });
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-loop-resume-"));
      const store = new FileRunStore(path.join(dir, "runs"));
      const first = await CoreMindRuntime.create({
        config,
        configDir: dir,
        initialPrompt: "修复缺陷",
        runStore: store,
      });

      const paused = await first.run();
      expect(paused.outcome).toMatchObject({ status: "paused", finishReason: "loop_paused" });
      expect((await store.read(paused.runId)).at(-1)?.kind).toBe("pause");

      const second = await CoreMindRuntime.create({
        config,
        configDir: dir,
        initialPrompt: "修复缺陷",
        runStore: store,
        resumeRunId: paused.runId,
      });
      const resumed = await second.run();

      expect(resumed.outcome.status).toBe("succeeded");
      expect(resumed.operation).toMatchObject({ state: "completed" });
      expect(resumed.transcript).toBe("candidate-b");
      expect((await store.read(paused.runId)).at(-1)?.kind).toBe("finish");
    } finally {
      await closeServer(server);
    }
  });

  it("Loop 修复次数耗尽后返回失败，不能接受不合格输出", async () => {
    const server = createTextSequenceServer(["candidate-a", "FAIL"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: loopConfig(port, { maxRepairs: 0 }),
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-loop-exhausted-")),
        initialPrompt: "修复缺陷",
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({
        status: "failed",
        finishReason: "loop_exhausted",
      });
      expect(result.transcript).toBe("candidate-a");
    } finally {
      await closeServer(server);
    }
  });

  it("Loop 只重试模型层确认的瞬态错误，并记录有界 retry 事件", async () => {
    let requests = 0;
    const responses = ["candidate-a", "PASS"];
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "service unavailable" } }));
        return;
      }
      const text = responses.shift() ?? "PASS";
      sendSse(response, [
        {
          id: `retry-${requests}`,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
        },
        { id: `retry-${requests}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...loopConfig(port),
          runtime: { maxRetries: 1 },
        },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-loop-retry-")),
        initialPrompt: "修复缺陷",
      });

      const result = await runtime.run();

      expect(result.outcome.status).toBe("succeeded");
      expect(requests).toBe(3);
      expect(
        result.trace.filter((entry) => entry.event.type === "retry").map((entry) => entry.event),
      ).toEqual([expect.objectContaining({ type: "retry", scope: "provider", attempt: 1 })]);
    } finally {
      await closeServer(server);
    }
  });

  it("Loop 总超时会传播取消并记录 timeout 控制器终态", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "late-loop",
              choices: [
                { index: 0, delta: { role: "assistant", content: "太晚" }, finish_reason: null },
              ],
            },
            { id: "late-loop", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 100);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: { ...loopConfig(port), runtime: { runTimeoutMs: 10, maxRetries: 0 } },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-loop-timeout-")),
        initialPrompt: "修复缺陷",
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({ status: "timeout", finishReason: "run_timeout" });
      expect(
        result.trace
          .filter((entry) => entry.event.type === "loop_state")
          .map((entry) => entry.event.to),
      ).toContain("timeout");
    } finally {
      await closeServer(server);
    }
  });

  it("外部中止会传播到 Loop 并记录 aborted 控制器终态", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "aborted-loop",
              choices: [
                { index: 0, delta: { role: "assistant", content: "太晚" }, finish_reason: null },
              ],
            },
            { id: "aborted-loop", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 100);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const abortController = new AbortController();
      let markLoopStarted: (() => void) | undefined;
      const loopStarted = new Promise<void>((resolve) => {
        markLoopStarted = resolve;
      });
      const runtime = await CoreMindRuntime.create({
        config: loopConfig(port),
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-loop-abort-")),
        initialPrompt: "修复缺陷",
        signal: abortController.signal,
        events: (event) => {
          if (event.type === "step_start" && event.stepId === "loop-execute:0") {
            markLoopStarted?.();
          }
        },
      });

      const runPromise = runtime.run();
      await loopStarted;
      abortController.abort();
      const result = await runPromise;

      expect(result.outcome).toMatchObject({ status: "aborted", finishReason: "aborted" });
      expect(result.operation).toMatchObject({ state: "failed", failureReason: "aborted" });
      expect(
        result.trace
          .filter((entry) => entry.event.type === "loop_state")
          .map((entry) => entry.event.to),
      ).toContain("aborted");
    } finally {
      await closeServer(server);
    }
  });

  it("迟到回复：abort 后流式输出完成 → transcript 无文本、trace 无 turn 终态、会话树无消息", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "late",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "迟到竞态赢家文本" },
                  finish_reason: null,
                },
              ],
            },
            { id: "late", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-late-reply-"));
      const abortController = new AbortController();
      const started = new Promise<void>((resolve) => {
        setTimeout(resolve, 15);
      });
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "迟到回复测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        initialPrompt: "执行",
        sessionId: "s1",
        signal: abortController.signal,
        runStore: new FileRunStore(path.join(dir, "runs")),
      });

      const runPromise = runtime.run();
      await started;
      abortController.abort();
      const result = await runPromise;

      // transcript 不含竞态赢家文本（方案 A：abort 生效后不回捞）
      expect(result.outcome.status).toBe("aborted");
      expect(result.transcript).not.toContain("迟到竞态赢家文本");
      // trace 无 turn 终态事件（abort 中断流式，不产生终态事实）
      expect(result.trace.some((entry) => entry.event.type === "turn_end")).toBe(false);
      // 会话树无该消息（D-4 方案 A：竞态赢家文本不落盘；无已确认部分可写）
      const sessionFile = path.join(dir, "sessions", "s1.jsonl");
      if (existsSync(sessionFile)) {
        expect(readFileSync(sessionFile, "utf8")).not.toContain("迟到竞态赢家文本");
      }
    } finally {
      await closeServer(server);
    }
  });

  it("R2 竞速：abort 与 run_timeout 同时触发时首次触发者（abort）胜出", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "r2-race",
              choices: [
                { index: 0, delta: { role: "assistant", content: "太慢" }, finish_reason: null },
              ],
            },
            { id: "r2-race", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const abortController = new AbortController();
      const started = new Promise<void>((resolve) => setTimeout(resolve, 5));
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "R2 竞速测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
          runtime: { runTimeoutMs: 30 },
        },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-r2-race-")),
        initialPrompt: "执行",
        signal: abortController.signal,
      });

      const runPromise = runtime.run();
      await started;
      abortController.abort(); // 与 30ms 超时竞速，abort 先到
      const result = await runPromise;

      expect(result.outcome).toMatchObject({ status: "aborted", finishReason: "aborted" });
    } finally {
      await closeServer(server);
    }
  });

  it("R2：多次中止幂等，首次触发者胜出", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "r2",
              choices: [
                { index: 0, delta: { role: "assistant", content: "太慢" }, finish_reason: null },
              ],
            },
            { id: "r2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const abortController = new AbortController();
      const started = new Promise<void>((resolve) => setTimeout(resolve, 10));
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "多次中止测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-r2-")),
        initialPrompt: "执行",
        signal: abortController.signal,
      });

      const runPromise = runtime.run();
      await started;
      abortController.abort();
      abortController.abort(); // 第二次中止无效果
      const result = await runPromise;

      expect(result.outcome).toMatchObject({ status: "aborted", finishReason: "aborted" });
      expect(result.operation).toMatchObject({ state: "failed", failureReason: "aborted" });
    } finally {
      await closeServer(server);
    }
  });

  it("R4：abort 后立刻 resume 被拒绝（run_already_finished）", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "r4",
              choices: [
                { index: 0, delta: { role: "assistant", content: "太慢" }, finish_reason: null },
              ],
            },
            { id: "r4", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-r4-"));
      const store = new FileRunStore(path.join(dir, "runs"));
      const abortController = new AbortController();
      const started = new Promise<void>((resolve) => setTimeout(resolve, 10));
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "R4 恢复拒绝测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: dir,
        initialPrompt: "执行",
        signal: abortController.signal,
        runStore: store,
      });

      const runPromise = runtime.run();
      await started;
      abortController.abort();
      const result = await runPromise;
      expect(result.outcome.status).toBe("aborted");

      // 恢复被拒绝：aborted 已写入 finish 记录
      const resumed = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "R4 恢复拒绝测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: dir,
        resumeRunId: result.runId,
        runStore: store,
      });
      await expect(resumed.run()).rejects.toMatchObject({ code: "run_already_finished" });
    } finally {
      await closeServer(server);
    }
  });

  it("R5：step 超时输出丢弃，错误码保持 step_timeout", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        if (!response.destroyed) {
          sendSse(response, [
            {
              id: "r5",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "超时后才到" },
                  finish_reason: null,
                },
              ],
            },
            { id: "r5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        }
      }, 80);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: loopConfig(port),
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-r5-")),
        initialPrompt: "执行",
        stepTimeoutMs: 20,
      });

      const result = await runtime.run();

      expect(result.outcome).toMatchObject({
        status: "timeout",
        finishReason: "step_timeout",
      });
      expect(result.transcript).not.toContain("超时后才到");
    } finally {
      await closeServer(server);
    }
  });

  it("R7：同实例并发 run() 抛 concurrent_run", async () => {
    const server = createServer(() => {
      // 不回复：让第一个 run 挂起
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "R7 并发测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-r7-")),
        initialPrompt: "执行",
      });

      const first = runtime.run();
      const second = runtime.run();
      await expect(second).rejects.toMatchObject({ code: "concurrent_run" });
      // 清理：第一个 run 需要结束（超时中止）
      first.catch(() => undefined);
    } finally {
      await closeServer(server);
    }
  });

  it("预生成 runId 被使用；resume 时以恢复记录为准", async () => {
    const server = createServer((_request, response) => {
      sendSse(response, [
        {
          id: "runid",
          choices: [
            { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
          ],
        },
        { id: "runid", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "预生成 runId 测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-runid-")),
        initialPrompt: "执行",
        runId: "pre-generated-run-id",
      });

      const result = await runtime.run();

      expect(result.runId).toBe("pre-generated-run-id");
      expect(result.trace.every((entry) => entry.runId === "pre-generated-run-id")).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("生命周期扩展的异常和超时只形成收据，不改变真实成功终态", async () => {
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const capabilities = {
      files: "none",
      process: false,
      network: false,
      credentials: false,
      ui: false,
    } as const;
    let finishedOperationState: unknown;
    const failed = defineLifecycleExtension({
      id: "failed-exporter",
      version: "1.0.0",
      capabilities,
      handlers: {
        "run-finished": ({ payload }) => {
          finishedOperationState = (payload.operation as { state?: unknown }).state;
          throw new Error("export failed");
        },
      },
    });
    const timeout = defineLifecycleExtension({
      id: "slow-exporter",
      version: "1.0.0",
      capabilities,
      handlers: { "before-model": () => new Promise(() => {}) },
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "扩展失败隔离",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-extension-isolation-")),
        initialPrompt: "执行",
        lifecycleExtensions: {
          extensions: [failed, timeout],
          trustedIds: [failed.id, timeout.id],
          grants: { [failed.id]: capabilities, [timeout.id]: capabilities },
          timeoutMs: 5,
        },
      });

      const result = await runtime.run();

      expect(result.outcome.status).toBe("succeeded");
      expect(finishedOperationState).toBe("completed");
      expect(result.snapshot.outcome).toEqual(result.outcome);
      expect(result.snapshot.extensions).toEqual(result.extensions);
      expect(result.extensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ extensionId: "failed-exporter", status: "failed" }),
          expect.objectContaining({ extensionId: "slow-exporter", status: "timed_out" }),
        ]),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("删除当次 Projection 后只从持久 Facts 重建相同 RunSnapshot", async () => {
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-projection-rebuild-"));
    const store = new FileRunStore(path.join(directory, "runs"));
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "投影重建",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: directory,
        initialPrompt: "执行",
        runStore: store,
      });

      const result = await runtime.run();
      const original = structuredClone(result.snapshot);
      let projection = ProjectionEngine.project(await store.read(result.runId));
      expect(projection.snapshot).toEqual(original);

      projection = undefined as never;
      const rebuilt = ProjectionEngine.project(await store.read(result.runId));

      expect(projection).toBeUndefined();
      expect(rebuilt.snapshot).toEqual(original);
    } finally {
      await closeServer(server);
    }
  });

  it("扩展只能在通用审批允许后追加拒绝，不能篡改审批结果", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-extension-deny-"));
    writeFileSync(path.join(dir, "notes.txt"), "扩展拒绝测试", "utf8");
    const server = createToolCallingServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const extension = createDenyPolicyExtension({ id: "deny-read", deniedTools: ["read"] });
    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {
          permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
        }),
        configDir: dir,
        cwd: dir,
        initialPrompt: "读取 notes.txt",
        approveTool: async () => "allow",
        lifecycleExtensions: {
          extensions: [extension],
          trustedIds: [extension.id],
          grants: { [extension.id]: extension.capabilities },
        },
      });

      const result = await runtime.run();

      expect(result.outcome.status).toBe("paused");
      expect(result.checkpoints).toHaveLength(0);
      expect(result.trace.some((entry) => entry.event.type === "approval_resolved")).toBe(true);
      expect(
        result.trace.some(
          (entry) => entry.event.type === "policy_denied" && entry.event.tool === "read",
        ),
      ).toBe(true);
      expect(result.extensions).toContainEqual(
        expect.objectContaining({ extensionId: "deny-read", denied: true }),
      );
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "tool_lifecycle" &&
            entry.event.resolution.phase === "executing" &&
            entry.event.resolution.status === "skipped",
        ),
      ).toBe(true);
      expect(
        result.trace.some(
          (entry) =>
            entry.event.type === "tool_lifecycle" &&
            entry.event.resolution.phase === "executing" &&
            entry.event.resolution.status === "completed",
        ),
      ).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("会话启用时 start 记录携带会话树水位关联字段", async () => {
    const server = createServer((_request, response) => {
      sendSse(response, [
        {
          id: "corr",
          choices: [
            { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
          ],
        },
        { id: "corr", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-session-seq-"));
      const cm = await CoreMindSession.open({
        dir: path.join(dir, "sessions"),
        sessionId: "s1",
        cwd: process.cwd(),
      });
      await cm.appendMessages([
        { id: "h1", role: "user", content: [{ type: "text", text: "历史一" }] },
        { id: "h2", role: "assistant", content: [{ type: "text", text: "历史二" }] },
      ]);
      const seqBefore = await cm.currentSeq();
      expect(seqBefore).toBeGreaterThan(0);

      const store = new MemoryRunStore();
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "关联字段测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        initialPrompt: "执行",
        sessionId: "s1",
        runStore: store,
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);
      const start = records.find((record) => record.kind === "start");
      expect(start?.payload).toMatchObject({
        sessionId: "s1",
        sessionSeqStart: seqBefore,
        turnSeqStart: seqBefore,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("请求级压缩把摘要条目落盘会话树，事件只带引用，重建消息与实际发送逐条一致", async () => {
    const captured: { messages: unknown[] }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        captured.push(JSON.parse(body) as { messages: unknown[] });
        sendSse(response, [
          {
            id: "compact",
            choices: [
              { index: 0, delta: { role: "assistant", content: "已继续" }, finish_reason: null },
            ],
          },
          { id: "compact", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-compact-"));
      const sessionDir = path.join(dir, "sessions");
      const cm = await CoreMindSession.open({
        dir: sessionDir,
        sessionId: "s1",
        cwd: process.cwd(),
      });
      const long = "旧历史内容".repeat(1_000);
      await cm.appendMessages([
        { id: "h1", role: "user", content: [{ type: "text", text: `${long}一` }] },
        { id: "h2", role: "assistant", content: [{ type: "text", text: `${long}二` }] },
        { id: "h3", role: "user", content: [{ type: "text", text: "最近完整问题" }] },
        { id: "h4", role: "assistant", content: [{ type: "text", text: "最近完整回答" }] },
      ]);

      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "压缩落盘测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 2048,
            maxTokens: 256,
          },
          agents: { main: { systemPrompt: "测试助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        initialPrompt: "继续完成",
        sessionId: "s1",
        events: (event) => events.push(event),
      });

      await runtime.run();

      // 压缩事件：只含指纹与会话树条目引用，不含摘要正文
      const compactedEvents = events.filter((event) => event.type === "context_compacted");
      expect(compactedEvents.length).toBeGreaterThan(0);
      const compacted = compactedEvents[0] as {
        summaryFingerprint?: string;
        sessionEntryId?: string;
      };
      expect(compacted.summaryFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof compacted.sessionEntryId).toBe("string");
      expect("summary" in compacted).toBe(false);

      // 会话树：压缩条目已落盘（追加不删除历史），persist 不重复摘要与保留区
      const reopened = await CoreMindSession.open({
        dir: sessionDir,
        sessionId: "s1",
        cwd: process.cwd(),
      });
      const entries = await reopened.branchEntries();
      const compactions = entries.filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(1);
      expect(compactions[0]?.details).toMatchObject({
        contextLifecycle: {
          compactionId: expect.stringMatching(/^[a-f0-9]{64}$/),
          strategyId: "task-state",
          strategyVersion: 1,
          lineageDepth: 1,
          rebuiltFromCanonical: false,
          trigger: "threshold",
        },
      });
      const taskState = JSON.parse(compactions[0]!.summary.split("\n").slice(1).join("\n")) as {
        goal?: string;
        sourceFacts?: { goal?: string[] };
      };
      expect(taskState).toMatchObject({
        goal: "继续完成",
        sourceFacts: { goal: [expect.stringContaining("start.initialPrompt")] },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "context_budget_resolved",
          source: "explicit_config",
          effectiveContextWindow: 2048,
          estimator: "pi-agent-core-estimate-v1",
        }),
      );

      // 重建 == 实际发送（忽略 system 前缀，逐条按内容比对）
      const sent = captured[0]!.messages.filter((message) => {
        const role = (message as { role?: string }).role;
        return role !== "system";
      });
      const rebuilt = applyCompaction(projectRawBranchMessages(entries), compactions);
      expect(rebuilt.map(contentOf)).toEqual(sent.map(contentOf));

      const resumeRuntime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "压缩恢复测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 2048,
            maxTokens: 256,
          },
          agents: { main: { systemPrompt: "测试助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        initialPrompt: "再次继续",
        sessionId: "s1",
      });
      await resumeRuntime.run();
      const resumedSent = captured[1]!.messages.filter(
        (message) => (message as { role?: string }).role !== "system",
      );
      const restoredPrefix = projectBranchMessages(entries).map((item) => item.message);
      expect(resumedSent.slice(0, restoredPrefix.length).map(contentOf)).toEqual(
        restoredPrefix.map(contentOf),
      );
      expect((resumedSent[0] as { role?: string }).role).toBe("user");
      expect(String(contentOf(resumedSent[0]))).toContain("[CoreMind TaskState v1]");
    } finally {
      await closeServer(server);
    }
  });

  it("压缩范围延伸进未落盘消息时仍落盘（范围截到已落盘末尾，重建无损）", async () => {
    const captured: { messages: unknown[] }[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        captured.push(JSON.parse(body) as { messages: unknown[] });
        sendSse(response, [
          {
            id: "overflow",
            choices: [
              { index: 0, delta: { role: "assistant", content: "已回复" }, finish_reason: null },
            ],
          },
          { id: "overflow", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-compact-overflow-"));
      const sessionDir = path.join(dir, "sessions");
      // 树里只有 2 条短消息；runAgentTurn 注入的 history（未落盘）更长
      const cm = await CoreMindSession.open({
        dir: sessionDir,
        sessionId: "s1",
        cwd: process.cwd(),
      });
      await cm.appendMessages([
        { id: "t1", role: "user", content: [{ type: "text", text: "树内一" }] },
        { id: "t2", role: "assistant", content: [{ type: "text", text: "树内二" }] },
      ]);

      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "压缩越界测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 2048,
            maxTokens: 256,
          },
          agents: { main: { systemPrompt: "测试助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        sessionId: "s1",
        events: (event) => events.push(event),
      });
      const long = "未落盘历史".repeat(600);
      await runtime.runAgentTurn(
        "main",
        "继续",
        [
          { id: "h1", role: "user", content: [{ type: "text", text: `${long}甲` }] },
          { id: "h2", role: "assistant", content: [{ type: "text", text: `${long}乙` }] },
          { id: "h3", role: "user", content: [{ type: "text", text: `${long}丙` }] },
          { id: "h4", role: "assistant", content: [{ type: "text", text: `${long}丁` }] },
          { id: "h5", role: "user", content: [{ type: "text", text: "最近完整问题" }] },
          { id: "h6", role: "assistant", content: [{ type: "text", text: "最近完整回答" }] },
        ],
        (event) => events.push(event),
      );

      // 压缩发生了且带会话树条目引用（范围截到已落盘末尾仍可落盘）
      const compacted = events.filter((event) => event.type === "context_compacted");
      expect(compacted.length).toBeGreaterThan(0);
      expect(compacted.some((event) => "sessionEntryId" in event && event.sessionEntryId)).toBe(
        true,
      );

      // 重建 == 实际发送
      const reopened = await CoreMindSession.open({
        dir: sessionDir,
        sessionId: "s1",
        cwd: process.cwd(),
      });
      const entries = await reopened.branchEntries();
      const compactions = entries.filter((entry) => entry.type === "compaction");
      const sent = captured[0]!.messages.filter((message) => {
        const role = (message as { role?: string }).role;
        return role !== "system";
      });
      const rebuilt = applyCompaction(projectRawBranchMessages(entries), compactions);
      expect(rebuilt.map(contentOf)).toEqual(sent.map(contentOf));
    } finally {
      await closeServer(server);
    }
  });

  it("没有可持久化 Session 时拒绝压缩，Provider 调用计数为 0", async () => {
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls += 1;
      sendSse(response, [
        { id: "unexpected", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-compact-without-session-"));
      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "无 Session 压缩门禁",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 2048,
            maxTokens: 256,
          },
          agents: { main: { systemPrompt: "测试助手" } },
        },
        configDir: dir,
        events: (event) => events.push(event),
      });
      const long = "不可只存在内存的旧历史".repeat(600);

      const result = await runtime.runAgentTurn(
        "main",
        "当前请求",
        [
          { id: "h1", role: "user", content: [{ type: "text", text: `${long}甲` }] },
          { id: "h2", role: "assistant", content: [{ type: "text", text: `${long}乙` }] },
          { id: "h3", role: "user", content: [{ type: "text", text: "上一完整问题" }] },
          { id: "h4", role: "assistant", content: [{ type: "text", text: "上一完整回答" }] },
        ],
        (event) => events.push(event),
      );

      expect(providerCalls).toBe(0);
      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "context_budget_exhausted" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "context_lifecycle_failed",
          code: "context_budget_exhausted",
          providerCallBlocked: true,
        }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("完整静态预算耗尽时在 Provider 前暂停，网络调用计数为 0", async () => {
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls += 1;
      sendSse(response, [
        { id: "unexpected", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-context-budget-"));
      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "Context 预算前门",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 1024,
            maxTokens: 256,
          },
          agents: { main: { systemPrompt: "不可删除项目规则".repeat(1000) } },
        },
        configDir: dir,
        initialPrompt: "不能发送",
        events: (event) => events.push(event),
      });

      const result = await runtime.run();

      expect(providerCalls).toBe(0);
      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "context_budget_exhausted" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "context_lifecycle_failed",
          code: "context_budget_exhausted",
          providerCallBlocked: true,
        }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("自定义端点缺省窗口显式记录 assumed_context_window 证据", async () => {
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls += 1;
      sendSse(response, [
        { id: "fallback", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-context-fallback-"));
      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "Context fallback",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "unknown-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "测试" } },
        },
        configDir: dir,
        initialPrompt: "执行",
        events: (event) => events.push(event),
      });

      await runtime.run();

      expect(providerCalls).toBe(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "context_budget_resolved",
          source: "conservative_fallback",
          confidence: "assumed",
          evidence: ["assumed_context_window"],
        }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("Provider 报告超窗时不盲目重试相同请求", async () => {
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls += 1;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "Your input exceeds the context window of this model" },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-provider-overflow-"));
      const events: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "Provider overflow",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 8192,
            maxTokens: 512,
          },
          agents: { main: { systemPrompt: "测试" } },
          runtime: { maxRetries: 3 },
        },
        configDir: dir,
        initialPrompt: "触发 Provider 超窗",
        events: (event) => events.push(event),
      });

      const result = await runtime.run();

      expect(providerCalls).toBe(1);
      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "context_budget_exhausted" },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "context_lifecycle_failed",
          reason: "provider_overflow",
          providerCallBlocked: true,
        }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("Resume 遇到损坏的 Context lineage 时失败关闭且不调用 Provider", async () => {
    let providerCalls = 0;
    const server = createServer((_request, response) => {
      providerCalls += 1;
      sendSse(response, [
        { id: "unexpected", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-lineage-corrupt-"));
      const sessionDir = path.join(dir, "sessions");
      const session = await CoreMindSession.open({ dir: sessionDir, sessionId: "s1", cwd: dir });
      await session.appendMessages([{ role: "user", content: "原始事实", timestamp: 1 }]);
      const sourceEntry = (await session.branchEntries())[0]!;
      await session.appendCompaction({
        summary: "[CoreMind TaskState v1]\n{}",
        retainedTail: [],
        tokensBefore: 100,
        details: {
          fingerprint: "f".repeat(64),
          rangeStartId: sourceEntry.id,
          rangeEndId: sourceEntry.id,
          summaryTimestamp: 1,
          contextLifecycle: {
            compactionId: "tampered",
            sourceFingerprint: "a".repeat(64),
            sourceRange: { start: 0, end: 1 },
            strategyId: "task-state",
            strategyVersion: 1,
            capabilityFingerprint: "b".repeat(64),
            budget: { availableInputTokens: 100, estimator: "pi-agent-core-estimate-v1" },
            tokensBefore: 100,
            tokensAfter: 10,
            summaryFingerprint: "c".repeat(64),
            retainedTailFingerprint: "d".repeat(64),
            taskStateFingerprint: "e".repeat(64),
            lineageDepth: 1,
            rebuiltFromCanonical: false,
            createdAt: 1,
            trigger: "threshold",
          },
        },
      });
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "lineage corrupt",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
            contextWindow: 8192,
            maxTokens: 512,
          },
          agents: { main: { systemPrompt: "测试" } },
          session: { enabled: true },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "恢复",
        sessionId: "s1",
      });

      const result = await runtime.run();

      expect(providerCalls).toBe(0);
      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "context_lineage_corrupt" },
      });
    } finally {
      await closeServer(server);
    }
  });

  it("默认本地观测显性且 DISABLED 不构造 Exporter、不读取凭据", async () => {
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const createExporter = vi.fn();
    const readCredentials = vi.fn();
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-observability-disabled-"));
      const port = (server.address() as AddressInfo).port;
      const store = new FileRunStore(path.join(dir, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: toolConfig(port, {}),
        configDir: dir,
        cwd: dir,
        initialPrompt: "执行",
        runStore: store,
        telemetry: { createExporter, readCredentials },
      });

      const result = await runtime.run();
      const facts = await store.read(result.runId);

      expect(result.outcome.status).toBe("succeeded");
      expect(result.observability).toMatchObject({
        localEnabled: true,
        run: { status: "finished" },
        telemetry: { mode: "DISABLED", source: "default", exporterLoaded: false },
      });
      expect(facts[0]?.payload).toMatchObject({
        telemetry: { mode: "DISABLED", contentLevel: "metrics_only", allowedFields: [] },
      });
      expect(createExporter).not.toHaveBeenCalled();
      expect(readCredentials).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("FULL Exporter 故障只更新交付投影，不改变 RunOutcome 与权威恢复投影", async () => {
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-observability-fault-"));
      const port = (server.address() as AddressInfo).port;
      const store = new FileRunStore(path.join(dir, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {}),
          telemetry: {
            mode: "FULL",
            endpoint: "https://telemetry.example/v1/traces?token=secret",
            contentLevel: "metrics_only",
            allowedFields: [],
          },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "执行",
        runStore: store,
        telemetry: {
          authorizeEgress: ({ endpointOrigin }) =>
            createTelemetryEgressAuthorization({
              targetOrigin: endpointOrigin,
              resolvedAddresses: ["192.0.2.10"],
            }),
          createExporter: () => ({
            export: async () => {
              throw new TelemetryExporterError("http_429", "注入限流");
            },
          }),
        },
      });

      const result = await runtime.run();
      const rebuilt = ProjectionEngine.project(await store.read(result.runId));

      expect(result.outcome.status).toBe("succeeded");
      expect(result.observability.telemetry).toMatchObject({
        mode: "FULL",
        failed: expect.any(Number),
        lastFailure: "http_429",
      });
      expect(result.observability.telemetry.failed).toBeGreaterThan(0);
      expect(rebuilt.outcome).toEqual(result.outcome);
      expect(rebuilt.recovery).toEqual({
        resumable: false,
        requiresHuman: false,
        operation: result.operation,
      });
      expect(rebuilt.observability.telemetry).toMatchObject({
        mode: "FULL",
        exporterLoaded: false,
        failed: 0,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("content consent 在 Exporter 前持久化并只暴露脱敏 endpoint origin", async () => {
    const server = createTextSequenceServer(["完成"]);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const exported: unknown[] = [];
    const factoryContexts: unknown[] = [];
    try {
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-observability-content-"));
      const port = (server.address() as AddressInfo).port;
      const store = new FileRunStore(path.join(dir, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {}),
          telemetry: {
            mode: "FULL",
            endpoint: "https://telemetry.example/v1/traces?token=secret",
            contentLevel: "content",
            allowedFields: ["start.initialPrompt"],
          },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "允许发送的正文",
        runId: "run-observability-content",
        runStore: store,
        telemetry: {
          consents: [
            createTelemetryConsentFact({
              runId: "run-observability-content",
              consentId: "content-1",
              kind: "content",
              targetOrigin: "https://telemetry.example",
              contentLevel: "content",
              allowedFields: ["start.initialPrompt"],
              retentionPurpose: "诊断该次用户授权反馈，保留 7 天",
              revocationMethod: "由调用方撤销该 consent，并向接收端发起删除",
              grantedAt: "2026-08-24T00:00:00.000Z",
            }),
          ],
          authorizeEgress: ({ endpointOrigin }) =>
            createTelemetryEgressAuthorization({
              targetOrigin: endpointOrigin,
              resolvedAddresses: ["192.0.2.10"],
            }),
          createExporter: (context) => {
            factoryContexts.push(context);
            return {
              export: async (record) => {
                exported.push(record);
              },
            };
          },
        },
      });

      const result = await runtime.run();
      const facts = await store.read(result.runId);
      const consentIndex = facts.findIndex((fact) => fact.kind === "telemetry_consent");
      const firstEventIndex = facts.findIndex((fact) => fact.kind === "event");

      expect(result.outcome.status).toBe("succeeded");
      expect(consentIndex).toBeGreaterThan(0);
      expect(consentIndex).toBeLessThan(firstEventIndex);
      expect(factoryContexts).toEqual([
        expect.objectContaining({
          endpointOrigin: "https://telemetry.example",
          authorization: expect.objectContaining({
            targetOrigin: "https://telemetry.example",
            redirectPolicy: "deny",
            proxyPolicy: "deny",
            tlsPolicy: "strict",
          }),
        }),
      ]);
      expect(JSON.stringify(exported)).toContain("允许发送的正文");
      expect(JSON.stringify(exported)).not.toContain("token=secret");
    } finally {
      await closeServer(server);
    }
  });
});

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function createToolCallingServer() {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const messages = (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages ?? [];
      if (messages.some((message) => message.role === "tool")) {
        sendSse(response, [
          {
            id: "final",
            choices: [
              { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
            ],
          },
          { id: "final", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
        return;
      }
      sendSse(response, [
        {
          id: "tool",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-read",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"notes.txt"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: "tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    });
  });
}

function createWriteCallingServer(toolName = "write") {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const messages = (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages ?? [];
      if (messages.some((message) => message.role === "tool")) {
        sendSse(response, [
          {
            id: "write-final",
            choices: [
              { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
            ],
          },
          { id: "write-final", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]);
        return;
      }
      sendSse(response, [
        {
          id: "write-tool",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-write",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: '{"path":"article.md","content":"已写入"}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "write-tool",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });
  });
}

function createParallelFailingToolServer() {
  return createServer((_request, response) => {
    sendSse(response, [
      {
        id: "parallel-tool",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-alpha",
                  type: "function",
                  function: { name: "alpha", arguments: "{}" },
                },
                {
                  index: 1,
                  id: "call-beta",
                  type: "function",
                  function: { name: "beta", arguments: "{}" },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: "parallel-tool",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
    ]);
  });
}

/** 消息的内容指纹（跨格式归一化：字符串 content 或文本块拼接） */
function contentOf(message: unknown): string {
  const record = message as {
    role?: string;
    content?: unknown;
    summary?: string;
    text?: string;
  };
  if (record.summary !== undefined) return `summary:${record.summary}`;
  if (typeof record.content === "string") return record.content;
  if (Array.isArray(record.content)) {
    return record.content
      .map((item) => {
        const block = item as { type?: string; text?: string };
        return block.type === "text" ? (block.text ?? "") : "";
      })
      .join("");
  }
  return record.text ?? "";
}

function toolConfig(
  port: number,
  overrides: Partial<Pick<CoreMindConfig, "runtime" | "permissions">>,
): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "Harness 测试",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKey: "test-key",
    },
    tools: [{ id: "read" }],
    agents: { main: { systemPrompt: "按要求调用工具" } },
    ...overrides,
  };
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function createTextSequenceServer(responses: string[]) {
  return createServer((_request, response) => {
    const text = responses.shift();
    if (text === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "缺少模拟响应" } }));
      return;
    }
    sendSse(response, [
      {
        id: `loop-${responses.length}`,
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      },
      {
        id: `loop-${responses.length}`,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]);
  });
}

function loopConfig(
  port: number,
  overrides: Partial<NonNullable<CoreMindConfig["loop"]>> = {},
): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "Loop Runtime 测试",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKey: "test-key",
    },
    agents: {
      coder: { systemPrompt: "编码" },
      reviewer: { systemPrompt: "验证" },
    },
    loop: {
      execute: { agent: "coder", input: "执行 {{prompt}}" },
      verify: {
        agent: "reviewer",
        input: "验证 {{candidate.text}}",
        passIf: "{{text}} == PASS",
      },
      repair: { agent: "coder", input: "根据 {{verification.text}} 修复" },
      maxIterations: 3,
      maxRepairs: 2,
      maxRepeatedAction: 3,
      onFailure: "repair",
      onExhausted: "fail",
      ...overrides,
    },
  };
}
