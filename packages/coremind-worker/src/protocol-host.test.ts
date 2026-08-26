import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
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
      expect(v2Projection.recovery).toEqual({ resumable: v1Result.snapshot.resumable });
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
        availableControls: ["cancel", "approval", "steering", "follow_up"],
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
    const start = (id: string) =>
      host.handle({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id,
        method: "run",
        params: { runId: "stable-run", input: "同一任务" },
      });

    const first = await start("start-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const duplicate = await start("start-2");

    expect({ first: (first as { result?: unknown }).result, duplicate, starts }).toEqual({
      first: (duplicate as { result?: unknown }).result,
      duplicate: {
        jsonrpc: "2.0",
        id: "start-2",
        result: (first as { result?: unknown }).result,
      },
      starts: 1,
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
  }, 15_000);

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
      10_000,
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
