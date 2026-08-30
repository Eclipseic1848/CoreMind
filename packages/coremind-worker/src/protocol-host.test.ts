import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CoreMindRuntimeOptions,
  FileRunStore,
  type RunControlCommand,
  RunStateJournal,
} from "coremind-ai";
import { ControlInbox, type RunId } from "coremind-ai/internal";
import { PROTOCOL_V2_VERSION } from "coremind-protocol";
import { describe, expect, it } from "vitest";
import { ProtocolHost } from "./index.js";

process.env.DEEPSEEK_API_KEY = "test-only";

describe("ProtocolHost", () => {
  it("v1 initialize 保留兼容入口并返回非错误迁移提示", async () => {
    const host = new ProtocolHost({ send: () => {} });

    const response = await host.handle({
      jsonrpc: "2.0",
      id: "init-v1",
      method: "initialize",
      params: {
        protocolVersion: "1.0",
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    expect(response).toMatchObject({
      result: {
        protocolVersion: "1.0",
        migration: {
          recommendedProtocol: "2.0",
          v1SupportedThrough: "0.4.x",
          earliestRemoval: "0.5.0",
        },
      },
    });
    expect(response).not.toHaveProperty("error");
  });

  it("v1 与 v2 run 映射到同一 Runtime 核心输入", async () => {
    const captured: CoreMindRuntimeOptions[] = [];
    const runtimeFactory = async (options: CoreMindRuntimeOptions) => {
      captured.push(options);
      return { run: () => new Promise<never>(() => {}) };
    };
    const config = { schemaVersion: 2 as const, name: "parity", agents: { main: {} } };
    const v1 = new ProtocolHost({ send: () => {}, runtimeFactory });
    const v2 = new ProtocolHost({ send: () => {}, runtimeFactory });
    await v1.handle({
      jsonrpc: "2.0",
      id: "init-v1-parity",
      method: "initialize",
      params: { protocolVersion: "1.0", config, configDir: ".", cwd: "." },
    });
    await initializeV2With(v2, { config, configDir: ".", cwd: "." });

    v1.accept({
      jsonrpc: "2.0",
      id: "run-v1-parity",
      method: "run",
      params: { runId: "parity-run", input: "同一输入" },
    });
    await v2.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "run-v2-parity",
      method: "run",
      params: { runId: "parity-run", input: "同一输入" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(captured).toHaveLength(2);
    expect(coreRuntimeInput(captured[1]!)).toEqual(coreRuntimeInput(captured[0]!));
    expect(captured[0]!.protocolStart).toBeUndefined();
    expect(captured[1]!.protocolStart).toMatchObject({
      protocolVersion: "2.0",
      method: "run",
    });
  });

  it("v1 与 v2 对共同 Fact、Outcome 和 RecoveryDecision 保持等价", async () => {
    const v1Dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v1-parity-"));
    const v2Dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-parity-"));
    const runId = "completed-parity-run";
    const runtimeFactory = completedParityRuntimeFactory();
    const v1 = new ProtocolHost({ send: () => {}, runtimeFactory });
    const v2 = new ProtocolHost({ send: () => {}, runtimeFactory });
    const config = { schemaVersion: 2 as const, name: "parity", agents: { main: {} } };
    try {
      await v1.handle({
        jsonrpc: "2.0",
        id: "init-v1-completed-parity",
        method: "initialize",
        params: { protocolVersion: "1.0", config, configDir: v1Dir, cwd: v1Dir },
      });
      await initializeV2With(v2, { config, configDir: v2Dir, cwd: v2Dir });

      const v1Response = await v1.handle({
        jsonrpc: "2.0",
        id: "run-v1-completed-parity",
        method: "run",
        params: { runId, input: "同一输入" },
      });
      await v2.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "run-v2-completed-parity",
        method: "run",
        params: { runId, input: "同一输入" },
      });
      const v2Projection = await waitForFinishedProjection(v2, runId);
      const v1Records = await new FileRunStore(path.join(v1Dir, ".coremind", "runs")).read(runId);
      const v2Records = await new FileRunStore(path.join(v2Dir, ".coremind", "runs")).read(runId);

      const v1Result = (
        v1Response as {
          result: { outcome: unknown; snapshot: { resumable: boolean } };
        }
      ).result;
      expect(v2Projection.outcome).toEqual(v1Result.outcome);
      expect(v2Projection.recovery).toEqual({
        resumable: v1Result.snapshot.resumable,
        requiresHuman: false,
      });
      expect(commonProtocolFacts(v2Records)).toEqual(commonProtocolFacts(v1Records));
    } finally {
      rmSync(v1Dir, { recursive: true, force: true });
      rmSync(v2Dir, { recursive: true, force: true });
    }
  });

  it("显式协商 v2 并返回服务器能力、schema fingerprint 与迁移提示", async () => {
    const host = new ProtocolHost({ send: () => {} });

    const response = await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: {
          minVersion: PROTOCOL_V2_VERSION,
          maxVersion: PROTOCOL_V2_VERSION,
        },
        capabilities: ["typedEvents", "controlInbox", "projectionQuery"],
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "init-v2",
      result: {
        selectedProtocol: "2.0",
        runtime: "node",
        warnings: [],
        serverCapabilities: [
          "runHandle",
          "typedEvents",
          "cursorResume",
          "controlInbox",
          "projectionQuery",
          "checkpointOperations",
          "dynamicTools",
        ],
        schemaFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        migration: {
          v1Supported: true,
          v1SupportedThrough: "0.4.x",
          earliestRemoval: "0.5.0",
        },
      },
    });
  });

  it("v2 Checkpoint 公开 list/create/diff/restore 且写操作按 operationId 幂等", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-checkpoint-"));
    const runId = "checkpoint-run";
    const actual = path.join(dir, "actual");
    const target = path.join(actual, "result.txt");
    try {
      await mkdir(actual);
      await symlink(
        actual,
        path.join(dir, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeFile(target, "修改前", "utf8");
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(runId, store);
      await journal.start({ configName: "checkpoint" });
      const host = new ProtocolHost({ send: () => {} });
      await initializeV2(host, dir);
      const request = (id: string, params: Record<string, unknown>) =>
        host.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id,
          method: "checkpoint",
          params: { schemaVersion: 1, runId, ...params },
        });

      const created = await request("create", {
        action: "create",
        operationId: "create-1",
        path: "actual/result.txt",
      });
      const duplicateCreate = await request("create-duplicate", {
        action: "create",
        operationId: "create-1",
        path: "alias/result.txt",
      });
      const checkpointId = (created as { result: { checkpoint: { checkpointId: string } } }).result
        .checkpoint.checkpointId;
      const listed = await request("list", { action: "list" });

      await writeFile(target, "修改后", "utf8");
      const currentSha256 = createHash("sha256").update("修改后").digest("hex");
      const diff = await request("diff", {
        action: "diff",
        checkpointId,
        checkpointVersion: 1,
      });
      expect(diff).not.toHaveProperty("result.unifiedDiff");
      const rejectedRestore = await request("restore-mismatch", {
        action: "restore",
        operationId: "restore-mismatch",
        checkpointId,
        checkpointVersion: 1,
        confirm: true,
        expectedCurrent: { existed: true, sha256: "0".repeat(64) },
      });
      const restored = await request("restore", {
        action: "restore",
        operationId: "restore-1",
        checkpointId,
        checkpointVersion: 1,
        confirm: true,
        expectedCurrent: { existed: true, sha256: currentSha256 },
      });
      const duplicateRestore = await request("restore-duplicate", {
        action: "restore",
        operationId: "restore-1",
        checkpointId,
        checkpointVersion: 1,
        confirm: true,
        expectedCurrent: { existed: true, sha256: currentSha256 },
      });

      expect(created).toMatchObject({
        result: {
          action: "create",
          operationId: "create-1",
          status: "applied",
          checkpoint: { checkpointVersion: 1, runId, path: "actual/result.txt" },
        },
      });
      expect(duplicateCreate).toMatchObject({ result: { status: "duplicate" } });
      expect(JSON.stringify(listed)).not.toContain("snapshotFile");
      expect(listed).toMatchObject({
        result: {
          action: "list",
          runId,
          checkpoints: [{ checkpointId, path: "actual/result.txt" }],
        },
      });
      expect(diff).toMatchObject({
        result: {
          action: "diff",
          runId,
          checkpointId,
          changed: true,
          current: { existed: true, sha256: currentSha256 },
        },
      });
      expect(rejectedRestore).toMatchObject({
        error: { data: { coremindCode: "checkpoint_conflict" } },
      });
      expect(restored).toMatchObject({
        result: { action: "restore", operationId: "restore-1", status: "applied" },
      });
      expect(duplicateRestore).toMatchObject({ result: { status: "duplicate" } });
      expect(await readFile(target, "utf8")).toBe("修改前");
      await writeFile(
        path.join(dir, ".coremind", "checkpoints", runId, `${checkpointId}.json`),
        "损坏的快照",
        "utf8",
      );
      await expect(
        request("create-corrupt-duplicate", {
          action: "create",
          operationId: "create-1",
          path: "alias/result.txt",
        }),
      ).resolves.toMatchObject({
        error: { data: { coremindCode: "checkpoint_corrupt" } },
      });
      await expect(request("list-corrupt", { action: "list" })).resolves.toMatchObject({
        error: { data: { coremindCode: "checkpoint_corrupt" } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v2 Checkpoint 写与不同 Run start 共用 Worker 单写者 transition", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-checkpoint-race-"));
    const checkpointRunId = "checkpoint-race-run";
    const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
    const journal = new RunStateJournal(checkpointRunId, store);
    await journal.start({ configName: "checkpoint-race" });
    await journal.flush();
    await writeFile(path.join(dir, "result.txt"), "原始内容", "utf8");

    let releaseCheckpointRead = () => {};
    const checkpointReadGate = new Promise<void>((resolve) => {
      releaseCheckpointRead = resolve;
    });
    let markCheckpointRead = () => {};
    const checkpointReadStarted = new Promise<void>((resolve) => {
      markCheckpointRead = resolve;
    });
    const read = store.read.bind(store);
    let delayCheckpointRead = true;
    store.read = async (runId) => {
      if (runId === checkpointRunId && delayCheckpointRead) {
        delayCheckpointRead = false;
        markCheckpointRead();
        await checkpointReadGate;
      }
      return read(runId);
    };

    let runtimeCreations = 0;
    let markRuntimeCreated = () => {};
    const runtimeCreated = new Promise<void>((resolve) => {
      markRuntimeCreated = resolve;
    });
    let completeRun = () => {};
    const runGate = new Promise<void>((resolve) => {
      completeRun = resolve;
    });
    const baseRuntimeFactory = completedParityRuntimeFactory();
    const host = new ProtocolHost({
      send: () => {},
      runStoreFactory: () => store,
      runtimeFactory: async (options) => {
        runtimeCreations += 1;
        markRuntimeCreated();
        const base = await baseRuntimeFactory(options);
        return {
          run: async () => {
            await runGate;
            return base.run();
          },
        };
      },
    });

    try {
      await initializeV2With(host, {
        config: { schemaVersion: 2, name: "checkpoint-race", agents: { main: {} } },
        configDir: dir,
        cwd: dir,
      });
      const checkpoint = host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "checkpoint-race",
        method: "checkpoint",
        params: {
          schemaVersion: 1,
          action: "create",
          operationId: "checkpoint-race-operation",
          runId: checkpointRunId,
          path: "result.txt",
        },
      });
      await checkpointReadStarted;
      const start = host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "start-race",
        method: "run",
        params: { runId: "competing-run", input: "不能与 Checkpoint 写重叠" },
      });

      await expect(
        Promise.race([
          runtimeCreated.then(() => "started"),
          new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 50)),
        ]),
      ).resolves.toBe("blocked");
      expect(runtimeCreations).toBe(0);

      releaseCheckpointRead();
      await expect(checkpoint).resolves.toMatchObject({ result: { status: "applied" } });
      await expect(start).resolves.toMatchObject({ result: { runId: "competing-run" } });
      expect(runtimeCreations).toBe(1);
      completeRun();
      await waitForFinishedProjection(host, "competing-run");
    } finally {
      releaseCheckpointRead();
      completeRun();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v2 动态工具只注册声明，并显式区分结果 duplicate/conflict/unknown/late", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-tools-"));
    const sent: unknown[] = [];
    let runtimeOptions: CoreMindRuntimeOptions | undefined;
    let completeRun = () => {};
    const baseRuntimeFactory = completedParityRuntimeFactory();
    const activeTool = async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const tool = runtimeOptions?.toolDefinitions?.[0];
        if (tool) return tool;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error("等待 v2 动态工具注册到 Runtime 超时");
    };
    const host = new ProtocolHost({
      send: (message) => sent.push(message),
      runtimeFactory: async (options) => {
        runtimeOptions = options;
        const base = await baseRuntimeFactory(options);
        return {
          run: async () => {
            await new Promise<void>((resolve) => {
              completeRun = resolve;
            });
            return base.run();
          },
        };
      },
    });
    await initializeV2With(host, {
      config: { schemaVersion: 2, name: "tools", agents: { main: {} } },
      configDir: dir,
      cwd: dir,
    });
    const definition = {
      schemaVersion: 1,
      registrationId: "registration-1",
      definitionVersion: 1,
      toolId: "lookup-record",
      name: "lookup_record",
      description: "读取一条记录",
      parameters: { type: "object", properties: { id: { type: "string" } } },
      effect: { operations: ["read"], reversible: true },
      capability: {
        effect: "none",
        replay: "safe",
        concurrency: "parallel",
        checkpoint: "none",
        durability: "ordinary",
      },
    } as const;
    const register = (id: string, params: unknown) =>
      host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id,
        method: "tool_register",
        params,
      });

    const registered = await register("register", definition);
    const duplicateRegistration = await register("register-duplicate", definition);
    const conflictingRegistration = await register("register-conflict", {
      ...definition,
      description: "不同定义",
    });
    const invalidRegistration = await register("register-invalid", {
      ...definition,
      registrationId: "registration-invalid",
      toolId: "unsafe-network",
      name: "unsafe_network",
      effect: { operations: ["network"], reversible: false },
    });
    const started = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "start-tools",
      method: "run",
      params: { runId: "tool-run", input: "执行工具" },
    });
    expect(started).toMatchObject({ result: { runId: "tool-run" } });
    const tool = await activeTool();
    const call = Promise.resolve(tool.execute({ id: "42" }, { callId: "call-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = (id: string, params: Record<string, unknown>) =>
      host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id,
        method: "tool_result",
        params: {
          schemaVersion: 1,
          resultId: "result-1",
          runId: "tool-run",
          callId: "call-1",
          registrationId: "registration-1",
          ...params,
        },
      });
    const accepted = await result("result", { result: { value: 42 } });
    const duplicate = await result("result-duplicate", { result: { value: 42 } });
    const conflict = await result("result-conflict", { result: { value: 43 } });
    const unknown = await result("result-unknown", {
      resultId: "result-unknown",
      callId: "call-unknown",
      result: null,
    });

    const controller = new AbortController();
    const cancelledCall = Promise.resolve(
      tool.execute({ id: "late" }, { callId: "call-late", signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(cancelledCall).rejects.toThrow(/中止/);
    expect(sent).toContainEqual({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      method: "tool_cancel",
      params: {
        schemaVersion: 1,
        runId: "tool-run",
        callId: "call-late",
        registrationId: "registration-1",
        toolId: "lookup-record",
        reason: "aborted",
      },
    });
    const cancelledConflict = await result("result-cancelled", {
      resultId: "result-late",
      callId: "call-late",
      result: null,
    });

    expect(registered).toMatchObject({ result: { status: "registered" } });
    expect(duplicateRegistration).toMatchObject({ result: { status: "duplicate" } });
    expect(conflictingRegistration).toMatchObject({ result: { status: "conflict" } });
    expect(invalidRegistration).toMatchObject({
      error: { data: { coremindCode: "invalid_tool" } },
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        protocolVersion: "2.0",
        method: "tool_call",
        params: expect.objectContaining({
          runId: "tool-run",
          callId: "call-1",
          registrationId: "registration-1",
          toolId: "lookup-record",
          argumentsFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        }),
      }),
    );
    expect(accepted).toMatchObject({ result: { status: "accepted" } });
    expect(duplicate).toMatchObject({ result: { status: "duplicate" } });
    expect(conflict).toMatchObject({ result: { status: "conflict" } });
    expect(unknown).toMatchObject({ result: { status: "unknown" } });
    expect(cancelledConflict).toMatchObject({ result: { status: "conflict" } });
    await expect(call).resolves.toEqual({ value: 42 });

    completeRun();
    await waitForFinishedProjection(host, "tool-run");
    runtimeOptions = undefined;
    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "start-tools-second-run",
      method: "run",
      params: { runId: "tool-run-second", input: "复用上游 CallId" },
    });
    const secondTool = await activeTool();
    const secondCall = Promise.resolve(secondTool.execute({ id: "43" }, { callId: "call-1" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondResult = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "result-second-run",
      method: "tool_result",
      params: {
        schemaVersion: 1,
        resultId: "result-second-run",
        runId: "tool-run-second",
        callId: "call-1",
        registrationId: "registration-1",
        result: { value: 43 },
      },
    });
    expect(secondResult).toMatchObject({ result: { status: "accepted" } });
    await expect(secondCall).resolves.toEqual({ value: 43 });
    completeRun();
    await waitForFinishedProjection(host, "tool-run-second");
    rmSync(dir, { recursive: true, force: true });
  });

  it("v2 工具结果在 Worker 重启后区分 unknown 与 late", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-tool-recovery-"));
    const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
    try {
      const host = new ProtocolHost({ send: () => {} });
      await initializeV2(host, dir);
      const definition = {
        schemaVersion: 1,
        definitionVersion: 1,
        description: "恢复后的声明式工具",
        parameters: { type: "object" },
        effect: { operations: ["read"], reversible: true },
        capability: {
          effect: "none",
          replay: "safe",
          concurrency: "parallel",
          checkpoint: "none",
          durability: "ordinary",
        },
      } as const;
      const registered = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "register:registration-1",
        method: "tool_register",
        params: {
          ...definition,
          registrationId: "registration-1",
          toolId: "lookup-record",
          name: "lookup_record",
        },
      });
      const definitionFingerprint = (registered as { result?: { definitionFingerprint?: string } })
        .result?.definitionFingerprint;
      expect(definitionFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
      await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "register:registration-wrong",
        method: "tool_register",
        params: {
          ...definition,
          registrationId: "registration-wrong",
          toolId: "other-record",
          name: "other_record",
        },
      });
      for (const [runId, committed] of [
        ["tool-unknown-run", false],
        ["tool-late-run", true],
      ] as const) {
        const journal = new RunStateJournal(runId, store);
        await journal.start({
          configName: "tool-recovery",
          protocolStart: {
            protocolVersion: "2.0",
            method: "run",
            fingerprint: `${runId}:start`,
            acceptedAt: "2026-08-30T00:00:00.000Z",
            toolRegistrations: [
              {
                registrationId: "registration-1",
                toolId: "lookup-record",
                name: "lookup_record",
                definitionFingerprint: definitionFingerprint!,
              },
            ],
          },
        });
        journal.event({
          eventId: `${runId}:call`,
          runId,
          sequence: 1,
          timestamp: "2026-08-30T00:00:00.000Z",
          event: {
            type: "tool_call",
            agent: "main",
            tool: "lookup_record",
            args: { id: "42" },
            callId: "persisted-call",
            idempotencyKey: `${runId}:persisted-call`,
          },
        });
        if (committed) {
          journal.event({
            eventId: `${runId}:receipt`,
            runId,
            sequence: 2,
            timestamp: "2026-08-30T00:00:01.000Z",
            event: {
              type: "effect_receipt",
              tool: "lookup_record",
              idempotencyKey: `${runId}:persisted-call`,
              status: "committed",
            },
          });
        }
        await journal.flush();
      }
      const result = (runId: string, registrationId = "registration-1") =>
        host.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id: runId,
          method: "tool_result",
          params: {
            schemaVersion: 1,
            resultId: `${runId}:result`,
            runId,
            callId: "persisted-call",
            registrationId,
            result: null,
          },
        });

      await expect(result("tool-unknown-run")).resolves.toMatchObject({
        result: { status: "unknown" },
      });
      await expect(result("tool-late-run")).resolves.toMatchObject({
        result: { status: "late" },
      });
      await expect(result("tool-late-run", "registration-wrong")).resolves.toMatchObject({
        result: { status: "conflict" },
      });

      const changedIdentityHost = new ProtocolHost({ send: () => {} });
      await initializeV2(changedIdentityHost, dir);
      await changedIdentityHost.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "register:changed-identity",
        method: "tool_register",
        params: {
          ...definition,
          registrationId: "registration-1",
          toolId: "lookup-record-v2",
          name: "lookup_record",
          parameters: { type: "object", properties: { key: { type: "string" } } },
        },
      });
      await expect(
        changedIdentityHost.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id: "changed-identity-result",
          method: "tool_result",
          params: {
            schemaVersion: 1,
            resultId: "changed-identity-result",
            runId: "tool-late-run",
            callId: "persisted-call",
            registrationId: "registration-1",
            result: null,
          },
        }),
      ).resolves.toMatchObject({ result: { status: "conflict" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v2 连接拒绝混用 v1 request envelope", async () => {
    const host = new ProtocolHost({ send: () => {} });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    const response = await host.handle({
      jsonrpc: "2.0",
      id: "mixed-run",
      method: "run",
      params: { input: "不能降级" },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: "mixed-run",
      error: {
        code: -32_601,
        message: "v2 连接不能混用 v1 request envelope",
        data: { coremindCode: "protocol_version_mixed" },
      },
    });
  });

  it("v2 run 在后台任务完成前返回 RunHandle", async () => {
    const neverCompletes = new Promise<never>(() => {});
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async () => ({ run: () => neverCompletes }),
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    const response = await withTimeout(
      host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "run-v2",
        method: "run",
        params: { runId: "run-v2-1", input: "长程任务" },
      }),
      250,
    );

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "run-v2",
      result: {
        runId: "run-v2-1",
        acceptedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        initialCursor: 0,
        selectedProtocol: "2.0",
        availableControls: [
          "cancel",
          "approval",
          "steering",
          "follow_up",
          "delegation_disposition",
        ],
      },
    });
  });

  it("相同 RunId 与输入重复 start 时幂等返回同一 RunHandle", async () => {
    let starts = 0;
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async () => ({
        run: () => {
          starts += 1;
          return new Promise<never>(() => {});
        },
      }),
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    const start = (id: string, runId = "stable-run", input = "同一任务") =>
      host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id,
        method: "run",
        params: { runId, input },
      });

    const first = await start("start-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const duplicate = await start("start-2");
    const competing = await start("start-competing", "competing-run", "另一个任务");

    expect({ first: (first as { result?: unknown }).result, duplicate, starts }).toEqual({
      first: (duplicate as { result?: unknown }).result,
      duplicate: {
        jsonrpc: "2.0",
        id: "start-2",
        result: (first as { result?: unknown }).result,
      },
      starts: 1,
    });
    expect(competing).toMatchObject({
      error: { data: { coremindCode: "worker_busy" } },
    });
  });

  it("v2 control 返回 Runtime ControlInbox 的持久回执", async () => {
    const accepted: unknown[] = [];
    let aborted = false;
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          run: () => new Promise<never>(() => {}),
          acceptControl: async (command) => {
            accepted.push(command);
            const applied = await options.applyControl!(command);
            if (typeof applied === "object" && applied.status === "applied") {
              await applied.afterDurable?.();
            }
            return {
              schemaVersion: 1,
              controlId: "cancel-1",
              runId: "controlled-run",
              status: "applied",
              appliedSequence: 2,
            };
          },
        };
      },
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "start",
      method: "run",
      params: { runId: "controlled-run", input: "执行" },
    });

    const response = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "cancel",
      method: "control",
      params: {
        schemaVersion: 1,
        controlId: "cancel-1",
        runId: "controlled-run",
        type: "cancel",
        reason: "用户停止",
      },
    });

    expect({ response, accepted, aborted }).toEqual({
      response: {
        jsonrpc: "2.0",
        id: "cancel",
        result: {
          schemaVersion: 1,
          controlId: "cancel-1",
          runId: "controlled-run",
          status: "applied",
          appliedSequence: 2,
        },
      },
      accepted: [
        {
          schemaVersion: 1,
          controlId: "cancel-1",
          runId: "controlled-run",
          type: "cancel",
          reason: "用户停止",
        },
      ],
      aborted: true,
    });
  });

  it("v2 Delegation Disposition 控制原样进入 Runtime ControlInbox", async () => {
    let accepted: RunControlCommand | undefined;
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async () => ({
        run: () => new Promise<never>(() => {}),
        acceptControl: async (command) => {
          accepted = command;
          return {
            schemaVersion: 1,
            controlId: command.controlId,
            runId: command.runId,
            status: "applied",
            appliedSequence: 4,
          };
        },
      }),
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "start-disposition",
      method: "run",
      params: { runId: "disposition-run", input: "等待处置" },
    });

    const response = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "apply-disposition",
      method: "control",
      params: {
        schemaVersion: 1,
        controlId: "disposition-control-1",
        runId: "disposition-run",
        type: "delegation_disposition",
        delegationId: "delegation-failed-1",
        action: "choose_alternative",
        reason: "人工选择替代方案",
      },
    });

    expect({ response, accepted }).toEqual({
      response: {
        jsonrpc: "2.0",
        id: "apply-disposition",
        result: {
          schemaVersion: 1,
          controlId: "disposition-control-1",
          runId: "disposition-run",
          status: "applied",
          appliedSequence: 4,
        },
      },
      accepted: {
        schemaVersion: 1,
        controlId: "disposition-control-1",
        runId: "disposition-run",
        type: "delegation_disposition",
        delegationId: "delegation-failed-1",
        action: "choose_alternative",
        reason: "人工选择替代方案",
      },
    });
  });

  it("暂停 Run 在没有活动 Runtime 时持久接收 Delegation Disposition", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-paused-disposition-control-"));
    const runId = "paused-disposition-run";
    try {
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(runId, store);
      await journal.start({ configName: "paused-disposition" });
      journal.pause({
        outcome: {
          status: "paused",
          finishReason: "delegation_disposition_required",
          error: {
            code: "delegation_disposition_required",
            message: "失败 Child Run 尚未处置",
          },
        },
      });
      await journal.flush();

      const host = new ProtocolHost({ send: () => {} });
      await initializeV2(host, dir);
      const command = {
        schemaVersion: 1 as const,
        controlId: "paused-disposition-control-1",
        runId,
        type: "delegation_disposition" as const,
        delegationId: "delegation-failed-1",
        action: "choose_alternative" as const,
        reason: "人工确认改走替代方案",
      };

      const accepted = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "accept-paused-disposition",
        method: "control",
        params: command,
      });
      const duplicate = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "duplicate-paused-disposition",
        method: "control",
        params: command,
      });
      const records = await store.read(runId);

      expect(accepted).toMatchObject({
        result: {
          controlId: command.controlId,
          runId,
          status: "accepted",
          acceptedSequence: 3,
        },
      });
      expect(duplicate).toMatchObject({
        result: {
          controlId: command.controlId,
          runId,
          status: "duplicate",
          duplicateOf: "accepted",
          acceptedSequence: 3,
        },
      });
      expect(
        records.filter(
          (record) =>
            record.kind === "control" &&
            (record.payload as { controlId?: string }).controlId === command.controlId,
        ),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ state: "accepted" }) }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("离线处置写入后不缓存过期 Run 状态", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-paused-disposition-stale-cache-"));
    const runId = "paused-disposition-stale-cache";
    try {
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(runId, store);
      await journal.start({ configName: "paused-disposition-stale-cache" });
      journal.pause({
        outcome: {
          status: "paused",
          finishReason: "delegation_disposition_required",
          error: {
            code: "delegation_disposition_required",
            message: "失败 Child Run 尚未处置",
          },
        },
      });
      await journal.flush();

      const host = new ProtocolHost({ send: () => {} });
      await initializeV2(host, dir);
      await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "accept-before-terminal",
        method: "control",
        params: {
          schemaVersion: 1,
          controlId: "control-before-terminal",
          runId,
          type: "delegation_disposition",
          delegationId: "delegation-failed-1",
          action: "choose_alternative",
          reason: "先持久接收处置",
        },
      });
      const acceptedRecords = await store.read(runId);
      const terminalJournal = new RunStateJournal(
        runId,
        store,
        acceptedRecords.at(-1)?.sequence ?? 0,
      );
      terminalJournal.finish({ outcome: { status: "succeeded", finishReason: "completed" } });
      await terminalJournal.flush();

      await expect(
        host.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id: "reject-after-terminal",
          method: "control",
          params: {
            schemaVersion: 1,
            controlId: "control-after-terminal",
            runId,
            type: "delegation_disposition",
            delegationId: "delegation-failed-2",
            action: "choose_alternative",
            reason: "终态后不应继续接收",
          },
        }),
      ).resolves.toMatchObject({
        error: { data: { coremindCode: "control_unavailable" } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("其他 Run 活动时暂停 Run 仍可持久接收离线 Delegation Disposition", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-paused-disposition-while-active-"));
    const pausedRunId = "paused-disposition-while-active";
    try {
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(pausedRunId, store);
      await journal.start({ configName: "paused-disposition-while-active" });
      journal.pause({
        outcome: {
          status: "paused",
          finishReason: "delegation_disposition_required",
          error: {
            code: "delegation_disposition_required",
            message: "失败 Child Run 尚未处置",
          },
        },
      });
      await journal.flush();

      const host = new ProtocolHost({
        send: () => {},
        runtimeFactory: async () => ({ run: () => new Promise<never>(() => {}) }),
      });
      await initializeV2(host, dir);
      await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "start-other-run",
        method: "run",
        params: { runId: "active-other-run", input: "保持活动" },
      });

      const response = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "accept-paused-disposition-while-active",
        method: "control",
        params: {
          schemaVersion: 1,
          controlId: "paused-disposition-control-while-active",
          runId: pausedRunId,
          type: "delegation_disposition",
          delegationId: "delegation-failed-while-active",
          action: "choose_alternative",
          reason: "人工确认改走替代方案",
        },
      });

      expect(response).toMatchObject({
        result: {
          controlId: "paused-disposition-control-while-active",
          runId: pausedRunId,
          status: "accepted",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一 Run 的离线处置写入完成后才允许 Resume 接管", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-control-resume-serialization-"));
    const runId = "serialized-control-resume-run";
    let releaseOfflineRead!: () => void;
    let markOfflineReadCaptured!: () => void;
    const offlineReadReleased = new Promise<void>((resolve) => {
      releaseOfflineRead = resolve;
    });
    const offlineReadCaptured = new Promise<void>((resolve) => {
      markOfflineReadCaptured = resolve;
    });
    let markRuntimeRecordsObserved!: () => void;
    const runtimeRecordsObserved = new Promise<void>((resolve) => {
      markRuntimeRecordsObserved = resolve;
    });
    try {
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(runId, store);
      await journal.start({ configName: "serialized-control-resume" });
      journal.pause({
        outcome: {
          status: "paused",
          finishReason: "delegation_disposition_required",
          error: {
            code: "delegation_disposition_required",
            message: "失败 Child Run 尚未处置",
          },
        },
      });
      await journal.flush();

      const read = store.read.bind(store);
      let delayNextRead = true;
      store.read = async (requestedRunId) => {
        const records = await read(requestedRunId);
        if (delayNextRead) {
          delayNextRead = false;
          markOfflineReadCaptured();
          await offlineReadReleased;
        }
        return records;
      };
      let runtimeCreations = 0;
      let recordsAtResume: Awaited<ReturnType<FileRunStore["read"]>> = [];
      const host = new ProtocolHost({
        send: () => {},
        runStoreFactory: () => store,
        runtimeFactory: async (options) => {
          runtimeCreations += 1;
          recordsAtResume = await options.runStore!.read(runId);
          markRuntimeRecordsObserved();
          return { run: () => new Promise<never>(() => {}) };
        },
      });
      await initializeV2(host, dir);
      const controlPromise = host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "serialize-offline-control",
        method: "control",
        params: {
          schemaVersion: 1,
          controlId: "serialize-offline-control-1",
          runId,
          type: "delegation_disposition",
          delegationId: "delegation-failed-1",
          action: "choose_alternative",
          reason: "人工确认替代方案",
        },
      });
      await offlineReadCaptured;
      const resumePromise = host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "serialize-resume",
        method: "resume",
        params: { runId, input: "继续执行" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const creationsBeforeControlCommit = runtimeCreations;

      releaseOfflineRead();
      const [control, resume] = await Promise.all([controlPromise, resumePromise]);
      await withTimeout(runtimeRecordsObserved, 1_000, "等待 Runtime 读取 Resume 记录超时");

      expect(creationsBeforeControlCommit).toBe(0);
      expect(control).toMatchObject({
        result: { runId, controlId: "serialize-offline-control-1", status: "accepted" },
      });
      expect(resume).toMatchObject({ result: { runId, selectedProtocol: "2.0" } });
      expect(runtimeCreations).toBe(1);
      expect(
        recordsAtResume.some(
          (record) =>
            record.kind === "control" &&
            (record.payload as { controlId?: string; state?: string }).controlId ===
              "serialize-offline-control-1" &&
            (record.payload as { state?: string }).state === "accepted",
        ),
      ).toBe(true);
    } finally {
      releaseOfflineRead();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("先到达的审批控制在审批点出现后只重试应用一次", async () => {
    let releaseApprovalPoint = () => {};
    const approvalPoint = new Promise<void>((resolve) => {
      releaseApprovalPoint = resolve;
    });
    let resolveDecision = (_decision: "allow" | "deny") => {};
    const resolvedDecision = new Promise<"allow" | "deny">((resolve) => {
      resolveDecision = resolve;
    });
    let pendingControl: RunControlCommand | undefined;
    let pendingRetries = 0;
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => ({
        run: async () => {
          await approvalPoint;
          const decision = await options.approveTool!({
            approvalId: "approval-early-1",
            runId: "approval-run",
            agent: "main",
            tool: "write",
            args: { path: "result.md" },
            argumentsFingerprint: "d".repeat(64),
            risk: "high",
            reason: "敏感工具需要批准",
            effect: {
              operations: ["write"],
              paths: ["result.md"],
              urls: [],
              reversible: true,
              declared: true,
            },
          });
          resolveDecision(decision);
          return new Promise<never>(() => {});
        },
        acceptControl: async (command) => {
          pendingControl = command;
          expect(await options.applyControl!(command)).toBe("accepted");
          return {
            schemaVersion: 1,
            controlId: command.controlId,
            runId: command.runId,
            status: "accepted",
            acceptedSequence: 1,
          };
        },
        applyPendingControls: async () => {
          pendingRetries += 1;
          if (!pendingControl) return [];
          const result = await options.applyControl!(pendingControl);
          if (typeof result === "object" && result.status === "applied") {
            await result.afterDurable?.();
          }
          return [];
        },
      }),
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-v2",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "start",
      method: "run",
      params: { runId: "approval-run", input: "等待审批" },
    });
    const accepted = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "approve-early",
      method: "control",
      params: {
        schemaVersion: 1,
        controlId: "approval-control-1",
        runId: "approval-run",
        type: "approval",
        approvalId: "approval-early-1",
        decision: "allow",
      },
    });

    releaseApprovalPoint();

    expect({
      accepted,
      decision: await withTimeout(resolvedDecision, 250),
      pendingRetries,
    }).toEqual({
      accepted: {
        jsonrpc: "2.0",
        id: "approve-early",
        result: {
          schemaVersion: 1,
          controlId: "approval-control-1",
          runId: "approval-run",
          status: "accepted",
          acceptedSequence: 1,
        },
      },
      decision: "allow",
      pendingRetries: 1,
    });
  });

  it("按 durable sequence 分页续读事件，并从同一前缀查询 Projection", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-events-"));
    const runId = "events-run";
    try {
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(runId, store);
      await journal.appendFact("start", { configName: "events" }, { eventId: "fact-start" });
      await journal.appendFact(
        "event",
        {
          eventId: "trace-agent-start",
          runId,
          sequence: 1,
          timestamp: "2026-08-25T00:00:01.000Z",
          event: { type: "agent_start", agent: "main", turnId: "turn-1" },
        },
        { eventId: "fact-agent-start" },
      );
      await new ControlInbox({
        runId: runId as RunId,
        journal,
        records: await store.read(runId),
        apply: async () => "accepted",
      }).accept({ schemaVersion: 1, controlId: "cancel-pending", runId, type: "cancel" });

      const host = new ProtocolHost({ send: () => {} });
      await host.handle({
        jsonrpc: "2.0",
        id: "init-v2",
        method: "initialize",
        params: {
          protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
          config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
          configDir: dir,
        },
      });
      const firstPageRequest = {
        jsonrpc: "2.0" as const,
        protocolVersion: "2.0" as const,
        id: "events-page-1",
        method: "events" as const,
        params: { runId, afterSequence: 0, limit: 2 },
      };
      const firstPage = await host.handle(firstPageRequest);
      const replayedFirstPage = await host.handle({ ...firstPageRequest, id: "events-replay" });
      const secondPage = await host.handle({
        ...firstPageRequest,
        id: "events-page-2",
        params: { runId, afterSequence: 2, limit: 2 },
      });
      const query = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "query",
        method: "query",
        params: { runId },
      });

      expect(firstPage).toMatchObject({
        result: {
          schemaVersion: 1,
          runId,
          afterSequence: 0,
          nextCursor: 2,
          hasMore: true,
          events: [
            {
              protocolVersion: "2.0",
              eventType: "fact.start",
              eventSchemaVersion: 1,
              runId,
              sequence: 1,
              eventId: "fact-start",
              payload: { configName: "events" },
              ignorable: false,
              sensitivity: "local",
            },
            {
              eventType: "agent_start",
              runId,
              sequence: 2,
              eventId: "fact-agent-start",
              turnId: "turn-1",
              payload: { type: "agent_start", agent: "main", turnId: "turn-1" },
            },
          ],
        },
      });
      expect((replayedFirstPage as { result?: { events?: unknown } }).result?.events).toEqual(
        (firstPage as { result?: { events?: unknown } }).result?.events,
      );
      expect(secondPage).toMatchObject({
        result: { afterSequence: 2, nextCursor: 3, hasMore: false, events: [{ sequence: 3 }] },
      });
      expect(query).toMatchObject({
        result: {
          schemaVersion: 1,
          runId,
          derivedFromSequence: 3,
          projection: {
            runId,
            status: "interrupted",
            pendingControls: [
              {
                source: "control_inbox",
                controlId: "cancel-pending",
                runId,
                type: "cancel",
                acceptedSequence: 3,
              },
            ],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Protocol v2 events 与 query 从同一 delegation Facts 返回等价 Child Run tree", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-child-runs-"));
    const runId = "child-tree-parent";
    try {
      const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
      const journal = new RunStateJournal(runId, store);
      await journal.start({ configName: "child-tree" });
      const identity = {
        parentRunId: runId,
        childRunId: "child-tree-child",
        delegationId: "delegation-tree",
        inputFingerprint: "sha256:tree",
        recordedAt: "2026-08-27T00:00:00.000Z",
      };
      const result = {
        outcome: { status: "succeeded", finishReason: "done" },
        evidence: ["event:child-done"],
        artifacts: [],
        workspaceChanges: [],
        unresolvedRisks: [],
      };
      const model = {
        providerId: "test",
        model: "test-model",
        providerConfigFingerprint: "sha256:test-provider-config",
        agentPromptFingerprint: "sha256:test-agent-prompt",
        agentDelegationFingerprint: "sha256:test-agent-delegation",
      };
      await journal.appendFact(
        "delegation",
        {
          type: "delegation_recorded",
          ...identity,
          parentTurnId: "turn-parent",
          parentStepId: "step-parent",
          agentName: "worker",
          model,
          workspace: { canonicalRoot: dir, lease: "shared_canonical" },
          lifecyclePolicy: {
            join: "structured",
            cancel: "propagate_parent",
            orphan: "audit_pause",
            detach: "forbidden",
          },
          context: { workingSetFingerprint: "sha256:context", references: [] },
          inheritedPolicy: {
            depth: 1,
            model,
            workspace: { canonicalRoot: dir, lease: "shared_canonical" },
            protectedContextReferences: [],
            budget: {
              tokens: 100,
              toolCalls: 1,
              costUsd: 1,
              wallTimeMs: 1_000,
              steps: 1,
              descendants: 0,
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
            maxActiveChildren: 4,
          },
          requestedAllocation: {
            tokens: 100,
            toolCalls: 1,
            costUsd: 1,
            wallTimeMs: 1_000,
            steps: 1,
            descendants: 0,
          },
          requestedPermissions: {
            mode: "ask",
            workspaceOnly: true,
            network: "deny",
            tools: ["read"],
            paths: ["."],
            credentials: [],
          },
          requestedEnvironment: { networkEgress: "denied" },
        },
        { durability: "critical", eventId: "delegation-recorded" },
      );
      await journal.appendFact(
        "delegation",
        { type: "child_created", ...identity },
        { durability: "critical", eventId: "child-created" },
      );
      await journal.appendFact(
        "delegation",
        { type: "child_running", ...identity },
        { eventId: "child-running" },
      );
      await journal.appendFact(
        "delegation",
        { type: "child_terminal", ...identity, result },
        { durability: "critical", eventId: "child-terminal" },
      );
      await journal.appendFact(
        "delegation",
        { type: "parent_joined", ...identity, result },
        { durability: "critical", eventId: "parent-joined" },
      );

      const host = new ProtocolHost({ send: () => {} });
      await initializeV2(host, dir);
      const events = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "child-events",
        method: "events",
        params: { runId, afterSequence: 1 },
      });
      const query = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "child-query",
        method: "query",
        params: { runId },
      });

      expect((events as { result?: { events?: unknown[] } }).result?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "fact.delegation",
            parentRunId: runId,
            childRunId: "child-tree-child",
            delegationId: "delegation-tree",
          }),
        ]),
      );
      expect(query).toMatchObject({
        result: {
          projection: {
            childRuns: {
              nodes: [
                expect.objectContaining({
                  parentRunId: runId,
                  childRunId: "child-tree-child",
                  delegationId: "delegation-tree",
                  agentName: "worker",
                  status: "joined",
                }),
              ],
              quiescent: true,
            },
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cursor 早于保留窗口时返回 Projection snapshot 与受控新游标", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-expired-cursor-"));
    const runId = "expired-cursor-run";
    const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
    const journal = new RunStateJournal(runId, store);
    await journal.appendFact("start", { configName: "expired" }, { eventId: "start-event" });
    await journal.appendFact("event", {
      eventId: "trace-1",
      runId,
      sequence: 1,
      timestamp: "2026-08-25T00:00:01.000Z",
      event: { type: "agent_start", agent: "main" },
    });
    await journal.appendFact("pause", { reason: "process_interrupted" });
    const windowedStore = Object.assign(store, {
      readEventWindow: async () => ({
        retainedFromSequence: 3,
        latestSequence: 3,
        records: (await store.read(runId)).filter((record) => record.sequence >= 3),
      }),
    });
    const host = new ProtocolHost({
      send: () => {},
      runStoreFactory: () => windowedStore,
    });

    try {
      await initializeV2(host, dir);
      const response = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "expired-events",
        method: "events",
        params: { runId, afterSequence: 0 },
      });

      expect(response).toMatchObject({
        error: {
          data: {
            coremindCode: "cursor_expired",
            details: {
              recovery: {
                runId,
                newCursor: 2,
                derivedFromSequence: 3,
                projection: { runId, status: "paused" },
              },
            },
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("持久前缀中的未知事件类型失败关闭", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-unknown-event-"));
    const runId = "unknown-event-run";
    try {
      const journal = new RunStateJournal(
        runId,
        new FileRunStore(path.join(dir, ".coremind", "runs")),
      );
      await journal.appendFact("start", { configName: "unknown-event" });
      await journal.appendFact("event", {
        eventId: "unknown-event-1",
        runId,
        sequence: 1,
        timestamp: "2026-08-25T00:00:01.000Z",
        event: { type: "future_non_ignorable_event", payload: "不能猜测" },
      });
      const host = new ProtocolHost({ send: () => {} });
      await host.handle({
        jsonrpc: "2.0",
        id: "init-v2",
        method: "initialize",
        params: {
          protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
          config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
          configDir: dir,
        },
      });

      expect(
        await host.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id: "events-unknown",
          method: "events",
          params: { runId, afterSequence: 0 },
        }),
      ).toMatchObject({
        error: {
          data: { coremindCode: "run_state_corrupt" },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已知事件缺少类型专属必填字段时失败关闭", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-v2-invalid-event-"));
    const runId = "invalid-known-event-run";
    try {
      const journal = new RunStateJournal(
        runId,
        new FileRunStore(path.join(dir, ".coremind", "runs")),
      );
      await journal.appendFact("start", { configName: "invalid-known-event" });
      await journal.appendFact("event", {
        eventId: "invalid-agent-start",
        runId,
        sequence: 1,
        timestamp: "2026-08-25T00:00:01.000Z",
        event: { type: "agent_start" },
      });
      const host = new ProtocolHost({ send: () => {} });
      await initializeV2(host, dir);

      expect(
        await host.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id: "events-invalid-known",
          method: "events",
          params: { runId, afterSequence: 0 },
        }),
      ).toMatchObject({ error: { data: { coremindCode: "run_state_corrupt" } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("v2 chat 与 resume 立即返回 RunHandle，并映射到同一 Runtime", async () => {
    let chatOptions: CoreMindRuntimeOptions | undefined;
    const chatHost = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => {
        chatOptions = options;
        return { run: () => new Promise<never>(() => {}) };
      },
    });
    await initializeV2(chatHost);
    const chat = await chatHost.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "chat",
      method: "chat",
      params: { runId: "chat-run", agent: "main", message: "继续讨论" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    let resumeOptions: CoreMindRuntimeOptions | undefined;
    const resumeHost = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => {
        resumeOptions = options;
        return { run: () => new Promise<never>(() => {}) };
      },
    });
    await initializeV2(resumeHost);
    const resume = await resumeHost.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "resume",
      method: "resume",
      params: { runId: "paused-run", input: "继续执行" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chat).toMatchObject({ result: { runId: "chat-run", selectedProtocol: "2.0" } });
    expect(chatOptions).toMatchObject({
      initialPrompt: "继续讨论",
      runId: "chat-run",
      config: { defaultAgent: "main", session: { enabled: true } },
    });
    expect(resume).toMatchObject({ result: { runId: "paused-run", selectedProtocol: "2.0" } });
    expect(resumeOptions).toMatchObject({
      initialPrompt: "继续执行",
      runId: "paused-run",
      resumeRunId: "paused-run",
    });
  });

  it("同一 RunId 跨 start method 返回 run_id_conflict", async () => {
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async () => ({ run: () => new Promise<never>(() => {}) }),
    });
    await initializeV2(host);
    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "run",
      method: "run",
      params: { runId: "method-conflict", input: "执行" },
    });

    expect(
      await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "chat",
        method: "chat",
        params: { runId: "method-conflict", agent: "main", message: "聊天" },
      }),
    ).toMatchObject({ error: { data: { coremindCode: "run_id_conflict" } } });
  });

  it("同一 Host 中首个运行结束后允许 resume 承接同一 RunId", async () => {
    const starts: CoreMindRuntimeOptions[] = [];
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => {
        starts.push(options);
        return { run: async () => Promise.reject(new Error("模拟运行已中断")) };
      },
    });
    await initializeV2(host);
    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "run-before-resume",
      method: "run",
      params: { runId: "same-host-resume", input: "初次执行" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resumed = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "resume-after-run",
      method: "resume",
      params: { runId: "same-host-resume", input: "恢复执行" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resumed).toMatchObject({
      result: { runId: "same-host-resume", selectedProtocol: "2.0" },
    });
    expect(starts).toHaveLength(2);
    expect(starts[1]).toMatchObject({
      runId: "same-host-resume",
      resumeRunId: "same-host-resume",
      initialPrompt: "恢复执行",
      protocolStart: { method: "resume" },
    });
  });

  it("Host 重启后从 start Fact 重建重复 start 的 RunHandle", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-host-restart-"));
    const runId = "host-restart-run";
    const params = { runId, input: "继续执行" };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ method: "run", params }))
      .digest("hex");
    const acceptedAt = "2026-08-25T00:00:00.000Z";
    const store = new FileRunStore(path.join(dir, ".coremind", "runs"));
    const journal = new RunStateJournal(runId, store);
    await journal.start({
      protocolStart: { protocolVersion: "2.0", method: "run", fingerprint, acceptedAt },
    });
    let runtimeCreations = 0;
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async () => {
        runtimeCreations++;
        return { run: () => new Promise<never>(() => {}) };
      },
    });

    try {
      await initializeV2(host, dir);
      const duplicate = await host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "duplicate-after-restart",
        method: "run",
        params,
      });

      expect(duplicate).toMatchObject({ result: { runId, acceptedAt } });
      expect(runtimeCreations).toBe(0);
      expect(await store.read(runId)).toEqual([
        expect.objectContaining({ kind: "start" }),
        expect.objectContaining({
          kind: "pause",
          payload: expect.objectContaining({ reason: "process_interrupted" }),
        }),
      ]);

      const conflictingHost = new ProtocolHost({
        send: () => {},
        runtimeFactory: async () => {
          runtimeCreations++;
          return { run: () => new Promise<never>(() => {}) };
        },
      });
      await initializeV2(conflictingHost, dir);
      expect(
        await conflictingHost.handle({
          jsonrpc: "2.0",
          protocolVersion: "2.0",
          id: "conflict-after-restart",
          method: "run",
          params: { runId, input: "不同输入" },
        }),
      ).toMatchObject({ error: { data: { coremindCode: "run_id_conflict" } } });
      expect(runtimeCreations).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("独立 Host 进程崩溃后重启不重复 Provider 或 Tool 副作用", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-host-crash-"));
    const effectMarker = path.join(dir, "effects.log");
    const runId = "host-process-crash-run";
    const input = "执行一次副作用后等待";
    const probe = fileURLToPath(
      new URL("../../../scripts/protocol-host-crash-probe.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [probe, dir, effectMarker, runId, input], {
      stdio: "pipe",
      windowsHide: true,
    });

    try {
      await waitForProbeReady(child);
      expect(child.exitCode).toBeNull();
      await forceTerminateChild(child);

      let runtimeCreations = 0;
      const restarted = new ProtocolHost({
        send: () => {},
        runtimeFactory: async () => {
          runtimeCreations++;
          return { run: () => new Promise<never>(() => {}) };
        },
      });
      await initializeV2(restarted, dir);
      const duplicate = await restarted.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "duplicate-after-process-crash",
        method: "run",
        params: { runId, input },
      });
      const records = await new FileRunStore(path.join(dir, ".coremind", "runs")).read(runId);
      const effects = (await readFile(effectMarker, "utf8")).trim().split("\n");

      expect(duplicate).toMatchObject({ result: { runId, selectedProtocol: "2.0" } });
      expect(runtimeCreations).toBe(0);
      expect(effects).toEqual(["provider", "tool"]);
      expect(records).toEqual([
        expect.objectContaining({ kind: "start" }),
        expect.objectContaining({
          kind: "pause",
          payload: expect.objectContaining({ reason: "process_interrupted" }),
        }),
      ]);
    } finally {
      try {
        await forceTerminateChild(child);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("正式 Child Run 在 Host 崩溃后先 orphan audit，再从同一事实前缀重建 tree", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coremind-protocol-child-crash-"));
    const configPath = path.join(dir, "probe-config.json");
    const effectMarker = path.join(dir, "effect-marker.log");
    const runId = "protocol-child-crash-parent";
    const probe = fileURLToPath(
      new URL("../../../scripts/protocol-child-run-crash-probe.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [probe, dir, configPath, runId], {
      stdio: "pipe",
      windowsHide: true,
    });
    let observer: ReturnType<typeof createServer> | undefined;

    try {
      await waitForProbeReady(child);
      await forceTerminateChild(child);
      const config = JSON.parse(await readFile(configPath, "utf8")) as {
        provider: { baseUrl: string };
      };
      const providerPort = Number(new URL(config.provider.baseUrl).port);
      let providerRequests = 0;
      observer = createServer((_request, response) => {
        providerRequests += 1;
        response.statusCode = 500;
        response.end("Resume 不得重新请求 Provider");
      });
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          observer!.once("error", onError);
          observer!.listen(providerPort, "127.0.0.1", () => {
            observer!.off("error", onError);
            resolve();
          });
        }),
        5_000,
        "等待 Provider observer 监听端口超时",
      );

      const restarted = new ProtocolHost({ send: () => {} });
      await withTimeout(
        initializeV2With(restarted, { config, configDir: dir, cwd: dir }),
        5_000,
        "等待重启 Host 初始化超时",
      );
      expect(
        await withTimeout(
          restarted.handle({
            jsonrpc: "2.0",
            protocolVersion: "2.0",
            id: "resume-child-after-host-crash",
            method: "resume",
            params: { runId, input: "启动 Child 并等待" },
          }),
          5_000,
          "等待崩溃后 Resume 返回超时",
        ),
      ).toMatchObject({ result: { runId, selectedProtocol: "2.0" } });

      let query: Awaited<ReturnType<ProtocolHost["handle"]>> | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        query = await withTimeout(
          restarted.handle({
            jsonrpc: "2.0",
            protocolVersion: "2.0",
            id: `query-child-after-crash-${attempt}`,
            method: "query",
            params: { runId },
          }),
          5_000,
          `等待崩溃恢复 Projection query 超时：attempt=${attempt}`,
        );
        const childRuns = (
          query as {
            result?: {
              projection?: {
                childRuns?: {
                  nodes?: Array<{
                    status?: string;
                    outcome?: { finishReason?: string };
                    disposition?: { state?: string; requiredActor?: string };
                  }>;
                };
              };
            };
          }
        ).result?.projection?.childRuns;
        if (
          childRuns?.nodes?.some(
            (node) =>
              node.status === "joined" &&
              node.outcome?.finishReason === "child_run_orphaned" &&
              node.disposition?.state === "required" &&
              node.disposition.requiredActor === "human",
          )
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const records = await new FileRunStore(path.join(dir, ".coremind", "runs")).read(runId);
      const lifecycle = records.flatMap((record) =>
        record.kind === "delegation" ? [(record.payload as { type: string }).type] : [],
      );
      const orphaned = lifecycle.indexOf("child_orphaned");
      const joined = lifecycle.indexOf("parent_joined");

      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(providerRequests).toBe(0);
      expect((await readFile(effectMarker, "utf8")).trim().split("\n")).toEqual(["child-effect"]);
      expect(orphaned).toBeGreaterThanOrEqual(0);
      expect(joined).toBeGreaterThan(orphaned);
      expect(query).toMatchObject({
        result: {
          projection: {
            childRuns: {
              nodes: [
                expect.objectContaining({
                  parentRunId: runId,
                  delegationId: expect.any(String),
                  childRunId: expect.any(String),
                  status: "joined",
                  outcome: expect.objectContaining({
                    status: "paused",
                    finishReason: "child_run_orphaned",
                  }),
                  disposition: expect.objectContaining({
                    state: "required",
                    requiredActor: "human",
                  }),
                }),
              ],
              activeDescendants: 0,
              unhandledDescendants: 1,
              quiescent: false,
            },
          },
        },
      });
      await withTimeout(restarted.shutdown(), 7_000, "等待重启 Host shutdown 超时");
    } finally {
      try {
        await forceTerminateChild(child);
      } finally {
        if (observer) {
          await withTimeout(
            new Promise<void>((resolve) => observer!.close(() => resolve())),
            2_000,
            "等待 Provider observer 关闭超时",
          );
        }
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 40_000);

  it("客户端断线导致 send 抛错时不取消或中断后台 Run", async () => {
    let continuedAfterTrace = false;
    let aborted = false;
    const host = new ProtocolHost({
      send: () => {
        throw new Error("client disconnected");
      },
      runtimeFactory: async (options) => {
        options.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          run: async () => {
            options.trace?.({
              runId: "disconnect-run",
              sequence: 1,
              eventId: "disconnect-event",
              timestamp: "2026-08-25T00:00:00.000Z",
              event: { type: "agent_start", agent: "main" },
            });
            continuedAfterTrace = true;
            return new Promise<never>(() => {});
          },
        };
      },
    });
    await initializeV2(host);

    await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: "disconnect-start",
      method: "run",
      params: { runId: "disconnect-run", input: "继续执行" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect({ continuedAfterTrace, aborted }).toEqual({
      continuedAfterTrace: true,
      aborted: false,
    });
  });

  it("父 Runtime 已返回但 Child tree 未静止时 shutdown 不谎报 quiescent", async () => {
    const baseFactory = completedParityRuntimeFactory();
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => {
        const base = await baseFactory({
          ...options,
          runId: options.runId ?? `non-quiescent-run-${Date.now()}`,
        });
        return {
          run: async () => ({
            ...(await base.run()),
            childRuns: {
              nodes: [],
              activeDescendants: 1,
              unhandledDescendants: 1,
              quiescent: false,
            },
          }),
        } as never;
      },
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-non-quiescent",
      method: "initialize",
      params: {
        protocolVersion: "1.0",
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    const response = await host.handle({
      jsonrpc: "2.0",
      id: "non-quiescent-run",
      method: "run",
      params: { input: "执行" },
    });

    expect(response).toMatchObject({ result: { childRuns: { quiescent: false } } });
    await expect(host.shutdown()).resolves.toEqual({ closed: true, quiescent: false });
  });

  it("父 Runtime 执行已静止但 Child 等待处置时 shutdown 按执行资源返回 quiescent", async () => {
    const baseFactory = completedParityRuntimeFactory();
    const host = new ProtocolHost({
      send: () => {},
      runtimeFactory: async (options) => {
        const base = await baseFactory({
          ...options,
          runId: options.runId ?? `disposition-pending-run-${Date.now()}`,
        });
        return {
          run: async () => ({
            ...(await base.run()),
            childRuns: {
              nodes: [{ status: "joined" }],
              activeDescendants: 0,
              unhandledDescendants: 1,
              quiescent: false,
            },
          }),
        } as never;
      },
    });
    await host.handle({
      jsonrpc: "2.0",
      id: "init-disposition-pending",
      method: "initialize",
      params: {
        protocolVersion: "1.0",
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    const response = await host.handle({
      jsonrpc: "2.0",
      id: "disposition-pending-run",
      method: "run",
      params: { input: "执行" },
    });

    expect(response).toMatchObject({ result: { childRuns: { quiescent: false } } });
    await expect(host.shutdown()).resolves.toEqual({ closed: true, quiescent: true });
  });
});

function completedParityRuntimeFactory() {
  return async (options: CoreMindRuntimeOptions) => ({
    run: async () => {
      const runId = options.runId!;
      const timestamp = "2026-08-25T00:00:00.000Z";
      const entry = {
        eventId: "parity-agent-start",
        runId,
        sequence: 1,
        timestamp,
        event: { type: "agent_start" as const, agent: "main" },
      };
      const journal = new RunStateJournal(runId, options.runStore!);
      await journal.start({
        configName: "parity",
        ...(options.protocolStart ? { protocolStart: options.protocolStart } : {}),
      });
      journal.event(entry);
      journal.finish({ outcome: { status: "succeeded", finishReason: "completed" } });
      await journal.flush();
      const operation = {
        schemaVersion: 1 as const,
        operationId: `operation-${runId}`,
        runId,
        correlationId: `${runId}:operation-${runId}`,
        state: "completed" as const,
        transitionSequence: 3,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const outcome = { status: "succeeded" as const, finishReason: "completed" };
      const metrics = {
        durationMs: 0,
        turns: 1,
        steps: { total: 0, succeeded: 0, failed: 0 },
        toolCalls: 0,
        toolFailures: 0,
        retries: 0,
        outputChars: 2,
      };
      const evaluation = {
        profile: "standard" as const,
        scenarioResults: [],
        qualityScores: {},
        securityFindings: [],
      };
      const releaseReadiness = { ready: false, blockers: ["fixture"], warnings: [] };
      return {
        runId,
        operation,
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
        trace: [entry],
        outputs: new Map(),
        messages: new Map(),
        transcript: "完成",
        checkpoints: [],
        observability: parityObservability(),
        snapshot: {
          schemaVersion: 1 as const,
          runId,
          operation,
          outcome,
          metrics,
          evaluation,
          releaseReadiness,
          trace: [entry],
          checkpoints: [],
          artifacts: [],
          extensions: [],
          resumable: false,
        },
      };
    },
  });
}

async function waitForProbeReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const succeed = () => {
      cleanup();
      resolve();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) succeed();
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(
        new Error(
          `Host 崩溃探针在 READY 前退出：code=${String(code)} signal=${String(signal)} ${stderr}`,
        ),
      );
    };
    const onError = (error: Error) => fail(error);
    const timer = setTimeout(
      () => fail(new Error(`等待 Host 崩溃探针 READY 超时：${stderr}`)),
      20_000,
    );
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function forceTerminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  const signaled = child.kill("SIGKILL");
  if (!signaled && child.exitCode === null && child.signalCode === null) {
    throw new Error("无法终止 Host 崩溃探针进程");
  }
  await exited;
}

async function waitForChildExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    }),
    10_000,
    "等待 Host 崩溃探针退出超时",
  );
}

function parityObservability() {
  return {
    schemaVersion: 1 as const,
    localEnabled: true as const,
    derivedFromSequence: 3,
    run: { status: "finished" as const, resumable: false },
    turns: { started: 1, completed: 1, active: 0 },
    calls: { started: 0, completed: 0, failed: 0, active: 0, durationMs: 0 },
    tools: [],
    errors: [],
    context: { budgets: 0, compactions: 0, failures: 0 },
    artifacts: { stored: 0, blocked: 0 },
    sharedState: { pendingControls: 0 },
    recovery: { resumable: false },
    telemetry: {
      mode: "DISABLED" as const,
      source: "default" as const,
      exporterLoaded: false,
      contentLevel: "metrics_only" as const,
      allowedFields: [],
      queued: 0,
      handedOff: 0,
      failed: 0,
      dropped: 0,
      duplicates: 0,
      shutdownTimedOut: false,
      deliverySemantics: "best_effort_handoff_not_delivery" as const,
      authorizedScopes: [],
    },
  };
}

async function waitForFinishedProjection(
  host: ProtocolHost,
  runId: string,
): Promise<{ outcome: unknown; recovery: unknown }> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await host.handle({
      jsonrpc: "2.0",
      protocolVersion: "2.0",
      id: `query-${attempt}`,
      method: "query",
      params: { runId },
    });
    const projection = (response as { result?: { projection?: Record<string, unknown> } }).result
      ?.projection;
    if (projection?.status === "finished") {
      return { outcome: projection.outcome, recovery: projection.recovery };
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待 v2 完成态 Projection 超时");
}

function commonProtocolFacts(records: Awaited<ReturnType<FileRunStore["read"]>>): unknown[] {
  return records.flatMap<unknown>((record) => {
    if (record.kind === "event") return [{ kind: record.kind, payload: record.payload }];
    if (record.kind === "finish") {
      return [{ kind: record.kind, outcome: (record.payload as { outcome?: unknown }).outcome }];
    }
    if (record.kind === "start") return [{ kind: record.kind, configName: "parity" }];
    return [];
  });
}

async function initializeV2(host: ProtocolHost, configDir = "."): Promise<void> {
  await initializeV2With(host, {
    config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
    configDir,
  });
}

async function initializeV2With(
  host: ProtocolHost,
  options: { config: unknown; configDir: string; cwd?: string },
): Promise<void> {
  await host.handle({
    jsonrpc: "2.0",
    id: "init-v2",
    method: "initialize",
    params: {
      protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
      config: options.config,
      configDir: options.configDir,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  });
}

function coreRuntimeInput(options: CoreMindRuntimeOptions): unknown {
  return {
    config: options.config,
    configDir: options.configDir,
    cwd: options.cwd,
    initialPrompt: options.initialPrompt,
    runId: options.runId,
    resumeRunId: options.resumeRunId,
    sessionId: options.sessionId,
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = "等待 RunHandle 超时",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
