import "../../../test/setup-env.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "./chat-session.js";
import { ControlInbox } from "./control-inbox.js";
import type { CoreMindToolDefinition } from "./external-tool.js";
import { ProjectionEngine } from "./projection.js";
import { FileRunStore, RunStateJournal } from "./run-state.js";
import { CoreMindRuntime, delegatedToolEnvironment } from "./runtime.js";
import { projectToolCallLifecycles } from "./tool-call-lifecycle.js";
import type { ToolApprovalRequest } from "./tool-policy.js";
import type { CoreMindTraceEvent } from "./trace.js";
import { canonicalizeWorkspace, WorkspaceLeaseService } from "./workspace-lease.js";

describe("Delegation Tool TypeScript happy path", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("Child 工具环境只保留平台运行必需变量", () => {
    expect(
      delegatedToolEnvironment({
        PATH: "runtime-path",
        TEMP: "runtime-temp",
        SAFE_FLAG: "not-explicitly-authorized",
        SENTRY_DSN: "non-typical-credential",
        SSH_AUTH_SOCK: "credential-capability",
        SERVICE_AUTH: "custom-credential",
      }),
    ).toEqual({ PATH: "runtime-path", TEMP: "runtime-temp" });
  });

  it("由活动父 Run 调用 allowlist Agent，并持久化可投影的结构化结果", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-tool-"));
    temporaryDirectories.push(directory);
    const requests: Array<Record<string, unknown>> = [];
    let markChildRequested = () => {};
    const childRequested = new Promise<void>((resolve) => {
      markChildRequested = resolve;
    });
    let releaseChildResponse = () => {};
    const childResponseReleased = new Promise<void>((resolve) => {
      releaseChildResponse = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
          temperature?: number;
          max_completion_tokens?: number;
          tools?: Array<{ function?: { name?: string } }>;
        };
        requests.push(payload as Record<string, unknown>);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        const hasDelegationTool =
          payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
        if (hasToolResult) {
          sendSse(response, textResponse("parent-final", "父任务完成"));
        } else if (hasDelegationTool) {
          sendSse(response, delegationResponse());
        } else {
          markChildRequested();
          void childResponseReleased.then(() => {
            sendSse(response, textResponse("child-final", "子任务完成"));
          });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "Delegation happy path",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: {
                tokens: 1_000,
                toolCalls: 2,
                costUsd: 1,
                wallTimeMs: 5_000,
                steps: 2,
                descendants: 1,
              },
              limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 5_000,
                    steps: 2,
                    descendants: 0,
                  },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。" },
        },
        defaultAgent: "main",
        runtime: {
          maxSteps: 4,
          maxToolCalls: 4,
          maxTokens: 2_000,
          maxCostUsd: 2,
          runTimeoutMs: 30_000,
        },
        permissions: { mode: "full", workspaceOnly: true, network: "allow" },
      };
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "完成父任务",
        runStore: store,
      });

      const chat = new ChatSession(runtime, "main");
      const resultPromise = chat.chat("完成父任务");
      const startup = await within(
        Promise.race([
          childRequested.then(() => ({ state: "child_requested" as const })),
          resultPromise.then((result) => ({ state: "parent_finished" as const, result })),
        ]),
        "Child 请求未到达且父 Run 未结束",
      );
      if (startup.state === "parent_finished") {
        throw new Error(`父 Run 提前结束：${JSON.stringify(startup.result.run.outcome)}`);
      }
      const activeProjection = await within(
        chat.inspectCurrentRunProjection(),
        "活动 Projection 查询阻塞",
      );
      expect(activeProjection?.childRuns).toMatchObject({
        activeDescendants: 1,
        unhandledDescendants: 1,
        quiescent: false,
        nodes: [expect.objectContaining({ agentName: "researcher", status: "running" })],
      });
      releaseChildResponse();
      const { run: result } = await within(resultPromise, "Child 响应后父 Run 未收敛");
      const parentRecords = await store.read(result.runId);
      const projection = await ProjectionEngine.projectTree(store, result.runId);
      const delegation = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const joined = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "parent_joined",
      );
      const childRunId = (delegation?.payload as { childRunId?: string } | undefined)?.childRunId;

      expect(result.outcome.status).toBe("succeeded");
      expect(result.transcript).toContain("父任务完成");
      expect(delegation?.payload).toMatchObject({
        type: "delegation_recorded",
        parentRunId: result.runId,
        agentName: "researcher",
        context: { references: [] },
        requestedAllocation: { tokens: 800, toolCalls: 2 },
        inheritedPolicy: {
          maxDepth: 1,
          maxActiveChildren: 0,
          maxDescendants: 0,
        },
      });
      expect(joined?.payload).toMatchObject({
        type: "parent_joined",
        childRunId,
        result: { outcome: { status: "succeeded" } },
      });
      expect(result.childRuns?.nodes).toEqual([
        expect.objectContaining({
          childRunId,
          status: "joined",
          outcome: { status: "succeeded", finishReason: "completed" },
        }),
      ]);
      expect(projection.childRuns).toEqual(result.childRuns);
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[0]?.tools)).toContain('"name":"delegate"');
      expect(JSON.stringify(requests[0]?.tools)).toContain('"maxDepth"');
      expect(JSON.stringify(requests[0]?.tools)).toContain('"maxActiveChildren"');
      expect(JSON.stringify(requests[1])).toContain("研究 Agent");
      expect(
        (requests[2]?.messages as Array<{ role?: string }> | undefined)?.some(
          (message) => message.role === "tool",
        ),
      ).toBe(true);
    } finally {
      releaseChildResponse();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("父 Agent 静默忽略非成功 Child 结果时不能形成成功终态", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-disposition-gate-"));
    temporaryDirectories.push(directory);
    let parentRequests = 0;
    let childRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        const parentRequest = payload.model === "probe-model";
        if (!parentRequest) {
          childRequests += 1;
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "模拟 Child Provider 失败" } }));
          return;
        }
        parentRequests += 1;
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        sendSse(
          response,
          hasToolResult
            ? textResponse("parent-ignored-failure", "忽略失败并宣称完成")
            : delegationResponse(),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: parentDelegationBudget(),
              targets: {
                researcher: {
                  budget: { ...parentDelegationBudget(), descendants: 0 },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。", model: "child-model" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "执行会失败的委派",
        runStore: store,
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);

      expect({ outcome: result.outcome, parentRequests, childRequests }).toMatchObject({
        outcome: {
          status: "paused",
          error: { code: "delegation_disposition_required" },
        },
        parentRequests: 2,
      });
      expect(childRequests).toBeGreaterThan(0);
      expect(
        records.some(
          (record) =>
            record.kind === "delegation" &&
            record.payload.type === "delegation_disposition_recorded",
        ),
      ).toBe(false);
      expect(result.childRuns).toMatchObject({
        nodes: [
          expect.objectContaining({
            status: "joined",
            disposition: expect.objectContaining({ state: "required" }),
          }),
        ],
        unhandledDescendants: 1,
        quiescent: false,
      });
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    {
      action: "choose_alternative" as const,
      reason: "人工已处置 Child，允许父级形成原终态",
    },
    {
      action: "propagate_terminal" as const,
      reason: "人工传播 Child 终态，但父级原终态仍应优先",
    },
    {
      action: "redelegate" as const,
      reason: "父级已有原终态时不允许重新委派",
    },
  ])("父级主动取消后 $action 处置遵守原终态优先级", async ({ action, reason }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-deferred-terminal-"));
    temporaryDirectories.push(directory);
    const runId = "deferred-parent-terminal";
    let parentRequests = 0;
    let markParentWaiting!: () => void;
    const parentWaiting = new Promise<void>((resolve) => {
      markParentWaiting = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { model?: string };
        if (payload.model !== "probe-model") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "模拟 Child Provider 失败" } }));
          return;
        }
        parentRequests += 1;
        if (parentRequests === 1) {
          sendSse(response, delegationResponse());
          return;
        }
        if (parentRequests === 2) {
          markParentWaiting();
          request.once("close", () => response.end());
          return;
        }
        sendSse(response, textResponse("unexpected-parent-resume", "不应再次请求 Provider"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const targetBudget = {
        ...parentDelegationBudget(),
        wallTimeMs: 500,
        descendants: 0,
      };
      const config = baseConfig((server.address() as AddressInfo).port, {
        main: {
          systemPrompt: "你是父 Agent。",
          delegation: {
            budget: parentDelegationBudget(),
            targets: { researcher: { budget: targetBudget } },
          },
        },
        researcher: { systemPrompt: "你是研究 Agent。", model: "child-model" },
      });
      const initialPrompt = "父级失败前已经收到非成功 Child";
      const controller = new AbortController();
      const firstRuntime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt,
        runId,
        runStore: store,
        signal: controller.signal,
      });

      const firstRun = firstRuntime.run();
      await parentWaiting;
      controller.abort();
      const paused = await firstRun;
      const pausedRecords = await store.read(runId);
      const delegationId = pausedRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      )?.payload.delegationId;
      const pausePayload = [...pausedRecords].reverse().find((record) => record.kind === "pause")
        ?.payload as
        | { deferredTerminalError?: { schemaVersion: 1; code: string; message: string } }
        | undefined;
      const deferred = pausePayload?.deferredTerminalError;

      expect(paused.outcome).toMatchObject({
        status: "paused",
        error: { code: "delegation_disposition_required" },
      });
      expect(deferred).toMatchObject({
        schemaVersion: 1,
        code: "aborted",
      });
      expect(delegationId).toMatch(/^delegation:/u);

      await new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store, pausedRecords.at(-1)!.sequence),
        records: pausedRecords,
        apply: async () => "accepted",
      }).accept({
        schemaVersion: 1,
        controlId: "deferred-terminal-disposition",
        runId,
        type: "delegation_disposition",
        delegationId: delegationId!,
        action,
        reason,
      });
      const requestsBeforeResume = parentRequests;
      const resumedRuntime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt,
        resumeRunId: runId,
        runStore: store,
      });

      const resumed = await resumedRuntime.run();
      const finalRecords = await store.read(runId);
      const redelegationRejected = action === "redelegate";

      expect(resumed.outcome).toMatchObject({
        status: redelegationRejected ? "paused" : "aborted",
        error: redelegationRejected
          ? { code: "delegation_disposition_required" }
          : { code: deferred?.code, message: deferred?.message },
      });
      expect(parentRequests).toBe(requestsBeforeResume);
      expect(finalRecords.at(-1)?.kind).toBe(redelegationRejected ? "pause" : "finish");
      expect(
        finalRecords.some(
          (record) =>
            record.kind === "delegation" &&
            record.payload.type === "delegation_disposition_recorded" &&
            record.payload.decidedBy === "human",
        ),
      ).toBe(!redelegationRejected);
      expect(
        [...finalRecords]
          .reverse()
          .find(
            (record) =>
              record.kind === "control" &&
              (record.payload as { controlId?: string }).controlId ===
                "deferred-terminal-disposition",
          )?.payload,
      ).toMatchObject(
        redelegationRejected
          ? {
              state: "rejected",
              reason: "父级已有待恢复终态，不能重新委派 Child Run",
            }
          : { state: "applied" },
      );
    } finally {
      await closeServer(server);
    }
  });

  it("父级终态持久撤销尚未建立 successor 的安全重新委派", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-redelegation-parent-terminal-"));
    temporaryDirectories.push(directory);
    const runId = "redelegation-parent-terminal";
    let parentRequests = 0;
    let markParentWaiting!: () => void;
    const parentWaiting = new Promise<void>((resolve) => {
      markParentWaiting = resolve;
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
          model?: string;
        };
        if (payload.model !== "probe-model") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "模拟 Child Provider 失败" } }));
          return;
        }
        parentRequests += 1;
        if (parentRequests === 1) {
          sendSse(response, delegationResponse());
          return;
        }
        if (parentRequests === 2) {
          const delegationId = delegationIdsFromToolMessages(payload.messages)[0];
          if (!delegationId) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "缺少 DelegationId" } }));
            return;
          }
          sendSse(
            response,
            namedToolCallResponse(
              "dispose_delegation",
              {
                delegationId,
                action: "redelegate",
                reason: "Child 在任何 Effect 前失败，准备安全重新委派",
              },
              "call-dispose-before-parent-terminal",
            ),
          );
          return;
        }
        if (parentRequests === 3) {
          markParentWaiting();
          request.once("close", () => response.end());
          return;
        }
        sendSse(
          response,
          textResponse("unexpected-parent-after-terminal", "不应再次请求 Provider"),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const targetBudget = {
        ...parentDelegationBudget(),
        wallTimeMs: 500,
        descendants: 0,
      };
      const config = baseConfig((server.address() as AddressInfo).port, {
        main: {
          systemPrompt: "你是父 Agent。",
          delegation: {
            budget: parentDelegationBudget(),
            targets: { researcher: { budget: targetBudget } },
          },
        },
        researcher: { systemPrompt: "你是研究 Agent。", model: "child-model" },
      });
      const controller = new AbortController();
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "安全重新委派前父级终止",
        runId,
        runStore: store,
        signal: controller.signal,
      });

      const running = runtime.run();
      await parentWaiting;
      controller.abort();
      const result = await running;
      const records = await store.read(runId);

      expect(result.outcome).toMatchObject({ status: "aborted", error: { code: "aborted" } });
      expect(parentRequests).toBe(3);
      expect(records.at(-1)?.kind).toBe("finish");
      expect(
        records.some(
          (record) =>
            record.kind === "delegation" &&
            (record.payload as { type?: string }).type === "delegation_redelegation_cancelled",
        ),
      ).toBe(true);
      expect(result.childRuns).toMatchObject({
        nodes: [
          expect.objectContaining({
            disposition: expect.objectContaining({
              state: "redelegation_cancelled",
              action: "redelegate",
            }),
          }),
        ],
        unhandledDescendants: 0,
        quiescent: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("父 Agent 持久化替代方案处置后才允许继续并成功结束", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "coremind-delegation-disposition-recorded-"),
    );
    temporaryDirectories.push(directory);
    let parentRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
          model?: string;
        };
        if (payload.model !== "probe-model") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "模拟 Child Provider 失败" } }));
          return;
        }
        parentRequests += 1;
        if (parentRequests === 1) {
          sendSse(response, delegationResponse());
          return;
        }
        if (parentRequests === 2) {
          const delegationId = delegationIdsFromToolMessages(payload.messages)[0];
          if (!delegationId) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "缺少 DelegationId" } }));
            return;
          }
          sendSse(
            response,
            namedToolCallResponse(
              "dispose_delegation",
              {
                delegationId,
                action: "choose_alternative",
                reason: "Child 在任何 Effect 前失败，改走父级只读替代方案",
              },
              "call-dispose-delegation",
            ),
          );
          return;
        }
        sendSse(response, textResponse("parent-after-disposition", "已按替代方案完成"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const targetBudget = {
        ...parentDelegationBudget(),
        wallTimeMs: 500,
        descendants: 0,
      };
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: parentDelegationBudget(),
              targets: { researcher: { budget: targetBudget } },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。", model: "child-model" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "失败后明确选择替代方案",
        runStore: store,
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);
      const disposition = records.find(
        (record) =>
          record.kind === "delegation" && record.payload.type === "delegation_disposition_recorded",
      );

      expect(result.outcome.status).toBe("succeeded");
      expect(result.transcript).toContain("已按替代方案完成");
      expect(parentRequests).toBe(3);
      expect(disposition?.payload).toMatchObject({
        action: "choose_alternative",
        decidedBy: "parent_agent",
        recovery: { recoveryDisposition: "replay_safe" },
      });
      expect(result.childRuns).toMatchObject({
        nodes: [
          expect.objectContaining({
            disposition: expect.objectContaining({
              state: "recorded",
              action: "choose_alternative",
            }),
          }),
        ],
        unhandledDescendants: 0,
        quiescent: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("暂停后接受的人工处置在恢复并重建 Child Coordinator 后应用", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-human-control-"));
    temporaryDirectories.push(directory);
    const runId = "human-disposition-parent";
    let parentRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
          model?: string;
        };
        if (payload.model !== "probe-model") {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "模拟 Child Provider 失败" } }));
          return;
        }
        parentRequests += 1;
        if (parentRequests === 1) {
          sendSse(response, delegationResponse());
          return;
        }
        sendSse(
          response,
          parentRequests === 2
            ? textResponse("parent-before-human-control", "忽略失败并结束")
            : textResponse("parent-after-human-control", "人工处置后继续完成"),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const targetBudget = {
        ...parentDelegationBudget(),
        wallTimeMs: 500,
        descendants: 0,
      };
      const config = baseConfig((server.address() as AddressInfo).port, {
        main: {
          systemPrompt: "你是父 Agent。",
          delegation: {
            budget: parentDelegationBudget(),
            targets: { researcher: { budget: targetBudget } },
          },
        },
        researcher: { systemPrompt: "你是研究 Agent。", model: "child-model" },
      });
      const initialPrompt = "等待人工处置失败 Child";
      const firstRuntime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt,
        runId,
        runStore: store,
      });

      const paused = await firstRuntime.run();
      const pausedRecords = await store.read(runId);
      const failedDelegationId = pausedRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      )?.payload.delegationId;
      expect(paused.outcome).toMatchObject({
        status: "paused",
        error: { code: "delegation_disposition_required" },
      });
      expect(failedDelegationId).toMatch(/^delegation:/u);

      const receipt = await new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store, pausedRecords.at(-1)!.sequence),
        records: pausedRecords,
        apply: async () => "accepted",
      }).accept({
        schemaVersion: 1,
        controlId: "human-disposition-control-1",
        runId,
        type: "delegation_disposition",
        delegationId: failedDelegationId!,
        action: "choose_alternative",
        reason: "人工确认改走父级替代方案",
      });
      const resumedRuntime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt,
        resumeRunId: runId,
        runStore: store,
      });

      const result = await resumedRuntime.run();
      const records = await store.read(runId);
      const disposition = records.find(
        (record) =>
          record.kind === "delegation" && record.payload.type === "delegation_disposition_recorded",
      );

      expect(receipt).toMatchObject({
        controlId: "human-disposition-control-1",
        status: "accepted",
      });
      expect(result.outcome.status).toBe("succeeded");
      expect(result.transcript).toContain("人工处置后继续完成");
      expect(parentRequests).toBe(3);
      expect(disposition?.payload).toMatchObject({
        delegationId: failedDelegationId,
        action: "choose_alternative",
        decidedBy: "human",
      });
      expect(
        records.filter(
          (record) =>
            record.kind === "control" && record.payload.controlId === "human-disposition-control-1",
        ),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ state: "accepted" }) }),
        expect.objectContaining({ payload: expect.objectContaining({ state: "applied" }) }),
      ]);
      expect(result.childRuns).toMatchObject({ unhandledDescendants: 0, quiescent: true });
    } finally {
      await closeServer(server);
    }
  });

  it("安全重新委派必须创建关联的新尝试并重新划拨预算", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-redelegate-"));
    temporaryDirectories.push(directory);
    const attemptBudget = {
      tokens: 400,
      toolCalls: 0,
      costUsd: 0.1,
      wallTimeMs: 500,
      steps: 1,
      descendants: 0,
    };
    const parentBudget = {
      tokens: 800,
      toolCalls: 0,
      costUsd: 0.2,
      wallTimeMs: 1_000,
      steps: 2,
      descendants: 2,
    };
    let parentRequests = 0;
    let recoveredChildRequests = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: unknown }>;
          model?: string;
        };
        if (payload.model !== "probe-model") {
          if (body.includes("安全重新委派第二次尝试")) {
            recoveredChildRequests += 1;
            sendSse(response, textResponse("child-redelegated", "第二次 Child 尝试成功"));
          } else {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "第一次 Child 尝试失败" } }));
          }
          return;
        }

        parentRequests += 1;
        const delegationIds = delegationIdsFromToolMessages(payload.messages);
        const predecessorDelegationId = delegationIds[0];
        if (parentRequests === 1) {
          sendSse(
            response,
            namedToolCallResponse(
              "delegate",
              {
                target: "researcher",
                task: "会在任何 Effect 前失败的第一次尝试",
                references: [],
                limits: { ...attemptBudget, maxDepth: 1, maxActiveChildren: 0 },
              },
              "call-delegate-first",
            ),
          );
          return;
        }
        if (!predecessorDelegationId) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "缺少前序 DelegationId" } }));
          return;
        }
        if (parentRequests === 2) {
          sendSse(
            response,
            namedToolCallResponse(
              "dispose_delegation",
              {
                delegationId: predecessorDelegationId,
                action: "redelegate",
                reason: "Trace 证明第一次尝试没有 Tool Call 或 Effect，可以建立新尝试",
              },
              "call-dispose-redelegate",
            ),
          );
          return;
        }
        if (parentRequests === 3) {
          sendSse(
            response,
            namedToolCallResponse(
              "delegate",
              {
                target: "researcher",
                task: "安全重新委派第二次尝试",
                references: [],
                recoveryOf: predecessorDelegationId,
                limits: { ...attemptBudget, maxDepth: 1, maxActiveChildren: 0 },
              },
              "call-delegate-recovery",
            ),
          );
          return;
        }
        sendSse(response, textResponse("parent-after-redelegation", "重新委派后完成"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: parentBudget,
              limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 2 },
              targets: { researcher: { budget: attemptBudget } },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。", model: "child-model" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "失败后按安全证明重新委派",
        runStore: store,
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);
      const delegations = records.flatMap((record) =>
        record.kind === "delegation" && record.payload.type === "delegation_recorded"
          ? [record.payload]
          : [],
      );
      const disposition = records.find(
        (record) =>
          record.kind === "delegation" && record.payload.type === "delegation_disposition_recorded",
      );

      expect(result.outcome.status).toBe("succeeded");
      expect(result.transcript).toContain("重新委派后完成");
      expect(parentRequests).toBe(4);
      expect(recoveredChildRequests).toBe(1);
      expect(delegations).toHaveLength(2);
      const [firstAttempt, secondAttempt] = delegations;
      expect(firstAttempt).toBeDefined();
      expect(secondAttempt).toBeDefined();
      expect(secondAttempt?.delegationId).not.toBe(firstAttempt?.delegationId);
      expect(secondAttempt?.childRunId).not.toBe(firstAttempt?.childRunId);
      expect(secondAttempt?.predecessorDelegationId).toBe(firstAttempt?.delegationId);
      expect(firstAttempt?.inheritedPolicy.budget).toEqual(attemptBudget);
      expect(secondAttempt?.inheritedPolicy.budget).toEqual(attemptBudget);
      expect(disposition?.payload).toMatchObject({
        delegationId: firstAttempt?.delegationId,
        action: "redelegate",
        recovery: { recoveryDisposition: "replay_safe", effectState: "none" },
      });
      expect(result.childRuns).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            delegationId: firstAttempt?.delegationId,
            disposition: expect.objectContaining({
              state: "recorded",
              action: "redelegate",
              successorDelegationId: secondAttempt?.delegationId,
            }),
          }),
          expect.objectContaining({
            delegationId: secondAttempt?.delegationId,
            predecessorDelegationId: firstAttempt?.delegationId,
            disposition: expect.objectContaining({ state: "not_required" }),
          }),
        ]),
        unhandledDescendants: 0,
        quiescent: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("Child Workspace 写入沿用父 canonical root，并保持 Checkpoint、Receipt 与 change summary 归属", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-workspace-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(path.join(directory, "runs"));
    const sharedCallId = "call-shared-writer";
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
        };
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        if (payload.model === "writer-model") {
          sendSse(
            response,
            hasToolResult
              ? textResponse("child-workspace-final", "子级写入完成")
              : writeToolResponse(sharedCallId, "shared.txt", "Child 写入内容"),
          );
          return;
        }
        sendSse(
          response,
          hasToolResult
            ? textResponse("parent-workspace-final", "父任务完成")
            : delegationResponseTo("writer", sharedCallId),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const config = baseConfig(port, {
        main: {
          systemPrompt: "你是父 Agent。",
          tools: [{ id: "write" }],
          delegation: {
            budget: parentDelegationBudget(),
            limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
            targets: {
              writer: { budget: { ...parentDelegationBudget(), descendants: 0 } },
            },
          },
        },
        writer: {
          systemPrompt: "你是写入 Agent。",
          model: "writer-model",
          tools: [{ id: "write" }],
        },
      });
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "委派写入任务",
        runStore: store,
      });

      const result = await runtime.run();
      expect(result.outcome.error).toBeUndefined();
      expect(result.outcome).toMatchObject({ status: "succeeded" });
      const childRunId = result.childRuns?.nodes[0]?.childRunId;
      expect(childRunId).toEqual(expect.any(String));
      const parentRecords = await store.read(result.runId);
      const childRecords = await store.read(childRunId!);
      const delegation = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const joined = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "parent_joined",
      );
      const childCheckpoint = childRecords
        .filter((record) => record.kind === "checkpoint")
        .at(-1)?.payload;
      const childEvents = childRecords.flatMap((record) =>
        record.kind === "event" ? [(record.payload as CoreMindTraceEvent).event] : [],
      );
      const childReceipts = childEvents.filter((event) => event.type === "effect_receipt");
      const parentReceipts = parentRecords
        .flatMap((record) =>
          record.kind === "event" ? [(record.payload as CoreMindTraceEvent).event] : [],
        )
        .filter((event) => event.type === "effect_receipt");
      const canonicalRoot = await canonicalizeWorkspace(directory);

      expect(result.outcome.status).toBe("succeeded");
      expect(await readFile(path.join(directory, "shared.txt"), "utf8")).toBe("Child 写入内容");
      expect(delegation?.payload).toMatchObject({
        workspace: { canonicalRoot, lease: "shared_canonical" },
      });
      expect(childEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "workspace_lease",
            status: "acquired",
            canonicalRoot,
            owner: expect.objectContaining({ runId: childRunId, callId: sharedCallId }),
          }),
        ]),
      );
      expect(childCheckpoint).toMatchObject({
        runId: childRunId,
        toolCallId: sharedCallId,
        existed: false,
        afterExisted: true,
        afterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(childReceipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "committed",
            binding: expect.objectContaining({ runId: childRunId, callId: sharedCallId }),
          }),
        ]),
      );
      expect(parentRecords.some((record) => record.kind === "checkpoint")).toBe(false);
      expect(
        parentReceipts.every(
          (receipt) => receipt.binding === undefined || receipt.binding.runId === result.runId,
        ),
      ).toBe(true);
      expect(joined?.payload).toMatchObject({
        result: {
          workspaceChanges: [
            {
              checkpointId: (childCheckpoint as { checkpointId?: string } | undefined)
                ?.checkpointId,
              path: "shared.txt",
              kind: "created",
              afterSha256: (childCheckpoint as { afterSha256?: string } | undefined)?.afterSha256,
            },
          ],
        },
      });

      await writeFile(path.join(directory, "shared.txt"), "用户后续修改", "utf8");
      const reopenedStore = new FileRunStore(path.join(directory, "runs"));
      const reopenedRuntime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        runStore: reopenedStore,
      });
      const reopenedTree = await ProjectionEngine.projectTree(reopenedStore, result.runId);
      const reopenedChildRunId = reopenedTree.childRuns?.nodes[0]?.childRunId;
      expect(reopenedChildRunId).toEqual(expect.any(String));
      const reopenedChildProjection = ProjectionEngine.project(
        await reopenedStore.read(reopenedChildRunId!),
      );
      const persistedCheckpoint = reopenedChildProjection.checkpoints.at(-1);
      expect(persistedCheckpoint).toMatchObject({
        checkpointId: (childCheckpoint as { checkpointId?: string } | undefined)?.checkpointId,
        afterExisted: true,
      });
      await expect(
        reopenedRuntime.restoreCheckpoint(persistedCheckpoint as never),
      ).rejects.toMatchObject({ code: "checkpoint_conflict" });
      expect(await readFile(path.join(directory, "shared.txt"), "utf8")).toBe("用户后续修改");
    } finally {
      await closeServer(server);
    }
  });

  it("父级持有写租约时 Child 写入失败关闭，取消后不覆盖用户修改或遗留租约", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-writer-race-"));
    temporaryDirectories.push(directory);
    await writeFile(path.join(directory, "protected.txt"), "用户已有内容", "utf8");
    const store = new FileRunStore(path.join(directory, "runs"));
    const controller = new AbortController();
    let markParentWriterEntered = () => {};
    const parentWriterEntered = new Promise<void>((resolve) => {
      markParentWriterEntered = resolve;
    });
    const heldWriter: CoreMindToolDefinition = {
      name: "held_write",
      description: "持有父级 Workspace Lease，直到父 Run 被取消",
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
        markParentWriterEntered();
        await new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(new Error("cancelled"));
          if (context.signal?.aborted) cancel();
          else context.signal?.addEventListener("abort", cancel, { once: true });
        });
      },
    };
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
        };
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        if (payload.model === "writer-model") {
          sendSse(
            response,
            hasToolResult
              ? textResponse("child-race-final", "子级结束")
              : writeToolResponse("call-child-race", "protected.txt", "不应覆盖"),
          );
          return;
        }
        sendSse(
          response,
          hasToolResult
            ? textResponse("parent-race-final", "父级结束")
            : parentWriterAndDelegationResponse(),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let run: ReturnType<CoreMindRuntime["run"]> | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: baseConfig(port, {
          main: {
            systemPrompt: "你是父 Agent。",
            tools: [{ id: "write" }],
            delegation: {
              budget: parentDelegationBudget(),
              limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
              targets: {
                writer: { budget: { ...parentDelegationBudget(), descendants: 0 } },
              },
            },
          },
          writer: {
            systemPrompt: "你是写入 Agent。",
            model: "writer-model",
            tools: [{ id: "write" }],
          },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "并行执行父写入与委派",
        runStore: store,
        toolDefinitions: [heldWriter],
        signal: controller.signal,
      });

      run = runtime.run();
      await within(parentWriterEntered, "父级 Writer 未取得 Workspace Lease");
      const parentRunId = await eventually(async () => {
        const inspection = await new WorkspaceLeaseService().inspect(directory);
        return inspection.state === "held" ? inspection.owner.runId : undefined;
      }, "父级 Workspace Lease 未进入 held");
      const childRunId = await eventually(async () => {
        const delegation = (await store.read(parentRunId)).find(
          (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
        );
        return (delegation?.payload as { childRunId?: string } | undefined)?.childRunId;
      }, "父级未持久化 ChildRunId");
      await eventually(async () => {
        const records = await store.read(childRunId);
        return records.some((record) => record.kind === "finish") ? true : undefined;
      }, "Child 写租约竞争未收敛");

      controller.abort();
      const result = await within(run, "取消后父 Run 未收敛");
      const childRecords = await store.read(childRunId);

      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "delegation_disposition_required" },
      });
      expect(result.childRuns?.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            childRunId,
            outcome: expect.objectContaining({
              status: "failed",
              error: expect.objectContaining({ code: "workspace_busy" }),
            }),
          }),
        ]),
      );
      expect(result.childRuns).toMatchObject({ quiescent: false });
      expect(childRecords.some((record) => record.kind === "checkpoint")).toBe(false);
      expect(await readFile(path.join(directory, "protected.txt"), "utf8")).toBe("用户已有内容");
      await expect(readFile(path.join(directory, "parent.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await new WorkspaceLeaseService().inspect(directory)).toMatchObject({
        state: "available",
      });
    } finally {
      controller.abort();
      await run?.catch(() => undefined);
      await closeServer(server);
    }
  }, 45_000);

  it("兄弟 Child 竞争真实 Lease 时父取消会在写入前收敛并释放租约", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-sibling-writers-"));
    temporaryDirectories.push(directory);
    const parentRunId = "sibling-writers-parent";
    const controller = new AbortController();
    let markWinnerStarted = () => {};
    const winnerStarted = new Promise<void>((resolve) => {
      markWinnerStarted = resolve;
    });
    let releaseWinner = () => {};
    const winnerReleased = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerRunId: string | undefined;
    let winnerCallId: string | undefined;
    const store = new FileRunStore(path.join(directory, "runs"), {
      beforeBarrier: async ({ runId, record }) => {
        const event =
          record?.kind === "event" ? (record.payload as CoreMindTraceEvent).event : undefined;
        if (
          winnerRunId === undefined &&
          runId !== parentRunId &&
          event?.type === "effect_receipt" &&
          event.status === "started" &&
          event.tool === "write"
        ) {
          winnerRunId = runId;
          winnerCallId = event.callId;
          markWinnerStarted();
          await winnerReleased;
        }
      },
    });
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string; content?: string }>;
          model?: string;
        };
        const serialized = JSON.stringify(payload);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        if (payload.model === "writer-model") {
          const isFirst = serialized.includes("写入 sibling-a.txt");
          sendSse(
            response,
            hasToolResult
              ? textResponse(isFirst ? "sibling-a-final" : "sibling-b-final", "子级结束")
              : writeToolResponse(
                  isFirst ? "call-sibling-a-write" : "call-sibling-b-write",
                  isFirst ? "sibling-a.txt" : "sibling-b.txt",
                  isFirst ? "Sibling A" : "Sibling B",
                ),
          );
          return;
        }
        sendSse(
          response,
          hasToolResult
            ? textResponse("sibling-parent-final", "父级完成")
            : siblingDelegationResponse(),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let run: ReturnType<CoreMindRuntime["run"]> | undefined;

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...baseConfig(port, {
            main: {
              systemPrompt: "你是父 Agent。",
              tools: [{ id: "write" }],
              delegation: {
                budget: {
                  tokens: 2_000,
                  toolCalls: 4,
                  costUsd: 2,
                  wallTimeMs: 10_000,
                  steps: 4,
                  descendants: 2,
                },
                limits: { maxDepth: 1, maxActiveChildren: 2, maxDescendants: 2 },
                targets: {
                  writer: {
                    budget: {
                      tokens: 800,
                      toolCalls: 2,
                      costUsd: 0.5,
                      wallTimeMs: 5_000,
                      steps: 2,
                      descendants: 0,
                    },
                  },
                },
              },
            },
            writer: {
              systemPrompt: "你是写入 Agent。",
              model: "writer-model",
              tools: [{ id: "write" }],
            },
          }),
          runtime: {
            maxSteps: 8,
            maxToolCalls: 8,
            maxTokens: 4_000,
            maxCostUsd: 4,
            runTimeoutMs: 20_000,
          },
        },
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "并行委派两个写入任务",
        runStore: store,
        runId: parentRunId,
        signal: controller.signal,
      });

      run = runtime.run();
      await within(winnerStarted, "首个 Child Writer 未进入 started durability barrier");
      const childRunIds = await eventually(
        async () => {
          const ids = (await store.read(parentRunId)).flatMap((record) => {
            if (record.kind !== "delegation" || record.payload.type !== "delegation_recorded") {
              return [];
            }
            return [(record.payload as { childRunId: string }).childRunId];
          });
          return ids.length === 2 ? ids : undefined;
        },
        "父级未并行创建两个兄弟 Child",
        3_000,
      );
      expect(winnerRunId).toEqual(expect.any(String));
      expect(winnerCallId).toEqual(expect.any(String));
      const blockedRunId = childRunIds.find((childRunId) => childRunId !== winnerRunId);
      expect(blockedRunId).toEqual(expect.any(String));
      await eventually(async () => {
        const records = await store.read(blockedRunId!);
        return records.some((record) => record.kind === "finish") ? true : undefined;
      }, "竞争失败的兄弟 Child 未收敛");
      controller.abort();
      await eventually(async () => {
        const records = await store.read(parentRunId);
        return records.some(
          (record) =>
            record.kind === "delegation" &&
            (record.payload as { type?: string; childRunId?: string }).type ===
              "child_cancel_requested" &&
            (record.payload as { childRunId?: string }).childRunId === winnerRunId,
        )
          ? true
          : undefined;
      }, "父取消未传播到持有 Lease 的 Child");
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseWinner();
      const result = await within(run, "父取消并释放 durability barrier 后 Run 未收敛");
      const tree = await ProjectionEngine.projectTree(store, parentRunId);
      const winnerRecords = await store.read(winnerRunId!);
      const winnerEvents = winnerRecords.flatMap((record) =>
        record.kind === "event" ? [(record.payload as CoreMindTraceEvent).event] : [],
      );
      const winnerLeaseEvents = winnerEvents.filter(
        (event) => event.type === "workspace_lease" && event.owner.callId === winnerCallId,
      );
      const winnerLifecycle = projectToolCallLifecycles(
        winnerEvents.filter((event) => event.type === "tool_lifecycle"),
      ).find((state) => state.callId === winnerCallId);
      const parentLifecycle = (await store.read(parentRunId)).flatMap((record) => {
        if (
          record.kind !== "delegation" ||
          (record.payload as { childRunId?: string }).childRunId !== winnerRunId
        ) {
          return [];
        }
        return [(record.payload as { type: string }).type];
      });
      const fileReads = await Promise.allSettled([
        readFile(path.join(directory, "sibling-a.txt"), "utf8"),
        readFile(path.join(directory, "sibling-b.txt"), "utf8"),
      ]);

      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "delegation_disposition_required" },
      });
      expect(tree.childRuns?.nodes).toHaveLength(2);
      expect(tree.childRuns).toMatchObject({ quiescent: false });
      expect(
        tree.childRuns?.nodes.find((node) => node.childRunId === winnerRunId)?.outcome,
      ).toMatchObject({ status: "aborted" });
      expect(
        tree.childRuns?.nodes.find((node) => node.childRunId === blockedRunId)?.outcome,
      ).toMatchObject({
        status: "failed",
        error: { code: "workspace_busy" },
      });
      expect(fileReads.every((read) => read.status === "rejected")).toBe(true);
      expect(winnerLifecycle).toMatchObject({
        terminal: true,
        currentPhase: "terminal",
        result: { executionOutcome: "aborted" },
      });
      expect(winnerLeaseEvents).toEqual([
        expect.objectContaining({
          type: "workspace_lease",
          status: "acquired",
          owner: expect.objectContaining({ runId: winnerRunId, callId: winnerCallId }),
        }),
        expect.objectContaining({
          type: "workspace_lease",
          status: "released",
          owner: expect.objectContaining({ runId: winnerRunId, callId: winnerCallId }),
        }),
      ]);
      expect(parentLifecycle).toEqual(
        expect.arrayContaining(["child_cancel_requested", "child_terminal", "parent_joined"]),
      );
      expect(parentLifecycle.indexOf("child_cancel_requested")).toBeLessThan(
        parentLifecycle.indexOf("child_terminal"),
      );
      expect(parentLifecycle.indexOf("child_terminal")).toBeLessThan(
        parentLifecycle.indexOf("parent_joined"),
      );
      expect(await new WorkspaceLeaseService().inspect(directory)).toMatchObject({
        state: "available",
      });
    } finally {
      controller.abort();
      releaseWinner();
      await run?.catch(() => undefined);
      await closeServer(server);
    }
  });

  it("正式产品路径保留命名 Agent 的后代委派并在任意深度维持收紧策略", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-tree-"));
    temporaryDirectories.push(directory);
    const parentRunId = "delegation-tree-parent";
    const store = new FileRunStore(path.join(directory, "runs"));
    let approvedReferences: string[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", async () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        requests.push(payload as Record<string, unknown>);
        const serialized = JSON.stringify(payload);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        const hasDelegationTool =
          payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
        if (hasToolResult) {
          sendSse(
            response,
            serialized.includes("你是研究 Agent")
              ? textResponse("researcher-final", "研究子任务完成")
              : textResponse("parent-final", "父任务完成"),
          );
        } else if (hasDelegationTool && serialized.includes("你是父 Agent")) {
          const approvedFact = (await store.read(parentRunId)).find((record) => record.eventId);
          if (!approvedFact?.eventId) throw new Error("父 Run 尚未持久化可引用 Fact");
          approvedReferences = [`fact:${approvedFact.eventId}`];
          sendSse(
            response,
            delegationResponseTo("researcher", "call-researcher", approvedReferences),
          );
        } else if (hasDelegationTool && serialized.includes("你是研究 Agent")) {
          sendSse(response, delegationResponseTo("reviewer", "call-reviewer", approvedReferences));
        } else {
          sendSse(response, textResponse("reviewer-final", "审查子任务完成"));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "Delegation tree",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: {
                tokens: 2_000,
                toolCalls: 4,
                costUsd: 2,
                wallTimeMs: 45_000,
                steps: 4,
                descendants: 2,
              },
              limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 2 },
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 30_000,
                    steps: 2,
                    descendants: 1,
                  },
                },
              },
            },
          },
          researcher: {
            systemPrompt: "你是研究 Agent。",
            model: "researcher-model",
            options: { temperature: 0.2, maxTokens: 1_200 },
            delegation: {
              budget: {
                tokens: 400,
                toolCalls: 1,
                costUsd: 0.4,
                wallTimeMs: 20_000,
                steps: 1,
                descendants: 1,
              },
              limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
              targets: {
                reviewer: {
                  budget: {
                    tokens: 400,
                    toolCalls: 1,
                    costUsd: 0.4,
                    wallTimeMs: 10_000,
                    steps: 1,
                    descendants: 0,
                  },
                },
              },
            },
          },
          reviewer: {
            systemPrompt: "你是审查 Agent。",
            model: "reviewer-model",
            options: { temperature: 0.1, maxTokens: 300 },
          },
        },
        defaultAgent: "main",
        runtime: {
          maxSteps: 8,
          maxToolCalls: 8,
          maxTokens: 4_000,
          maxCostUsd: 4,
          runTimeoutMs: 60_000,
        },
        permissions: { mode: "full", workspaceOnly: true, network: "allow" },
      };
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "完成父任务；PARENT_PRIVATE_MARKER；UNREFERENCED_FILE_MARKER",
        runStore: store,
        runId: parentRunId,
      });

      const result = await runtime.run();
      const tree = await ProjectionEngine.projectTree(store, result.runId);
      const researcherNode = tree.childRuns?.nodes.find((node) => node.agentName === "researcher");
      const rootDelegation = (await store.read(result.runId)).find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const nestedDelegation = researcherNode
        ? (await store.read(researcherNode.childRunId)).find(
            (record) =>
              record.kind === "delegation" && record.payload.type === "delegation_recorded",
          )
        : undefined;

      expect(result.outcome.status).toBe("succeeded");
      expect(tree.childRuns?.nodes).toEqual([
        expect.objectContaining({
          parentRunId: result.runId,
          agentName: "researcher",
          budget: expect.objectContaining({ tokens: 1_000, descendants: 1 }),
          outcome: { status: "succeeded", finishReason: "completed" },
        }),
        expect.objectContaining({
          agentName: "reviewer",
          budget: expect.objectContaining({ tokens: 400, descendants: 0 }),
          outcome: { status: "succeeded", finishReason: "completed" },
        }),
      ]);
      expect(rootDelegation?.payload).toMatchObject({
        budgetScope: "main",
        model: {
          providerId: "probe",
          model: "researcher-model",
          options: { temperature: 0.2, maxTokens: 1_000 },
        },
        inheritedPolicy: { depth: 1, maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
      });
      expect(nestedDelegation?.payload).toMatchObject({
        budgetScope: "researcher",
        model: {
          providerId: "probe",
          model: "reviewer-model",
          options: { temperature: 0.1, maxTokens: 300 },
        },
        inheritedPolicy: { depth: 2, maxDepth: 2, maxActiveChildren: 1, maxDescendants: 0 },
      });
      expect(requests).toHaveLength(5);
      const researcherRequests = requests.filter((request) =>
        JSON.stringify(request).includes("你是研究 Agent"),
      );
      const reviewerRequests = requests.filter((request) =>
        JSON.stringify(request).includes("你是审查 Agent"),
      );
      const parentJoinRequest = requests.find(
        (request) =>
          JSON.stringify(request).includes("你是父 Agent") &&
          (request.messages as Array<{ role?: string }> | undefined)?.some(
            (message) => message.role === "tool",
          ),
      );
      const parentToolMessage = (
        parentJoinRequest?.messages as Array<{ role?: string; content?: string }> | undefined
      )?.find((message) => message.role === "tool");
      const parentToolResult = JSON.parse(parentToolMessage?.content ?? "null") as unknown;
      expect(researcherRequests).not.toHaveLength(0);
      const researcherInitialRequest = researcherRequests.find(
        (request) =>
          !(request.messages as Array<{ role?: string }> | undefined)?.some(
            (message) => message.role === "tool",
          ),
      );
      expect(approvedReferences).toHaveLength(1);
      expect(JSON.stringify(researcherInitialRequest)).toContain(approvedReferences[0]!);
      expect(JSON.stringify(researcherInitialRequest)).not.toContain("PARENT_PRIVATE_MARKER");
      expect(JSON.stringify(researcherInitialRequest)).not.toContain("UNREFERENCED_FILE_MARKER");
      expect(JSON.stringify(researcherInitialRequest)).not.toContain("test-key");
      expect(parentToolResult).toMatchObject({
        childRunId: expect.any(String),
        result: {
          outcome: { status: "succeeded", finishReason: "completed" },
          evidence: expect.any(Array),
          artifacts: expect.any(Array),
          workspaceChanges: expect.any(Array),
          unresolvedRisks: expect.any(Array),
        },
      });
      expect(JSON.stringify(parentJoinRequest)).not.toContain("审查子任务完成");
      expect(JSON.stringify(parentJoinRequest)).not.toContain("研究子任务完成");
      expect(JSON.stringify(parentJoinRequest)).not.toContain("你是研究 Agent");
      expect(JSON.stringify(parentJoinRequest)).not.toContain("你是审查 Agent");
      expect(researcherRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: "researcher-model",
            temperature: 0.2,
            max_completion_tokens: 1_000,
          }),
        ]),
      );
      expect(reviewerRequests).not.toHaveLength(0);
      expect(reviewerRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            model: "reviewer-model",
            temperature: 0.1,
            max_completion_tokens: 300,
          }),
        ]),
      );
    } finally {
      await closeServer(server);
    }
  }, 45_000);

  it("非默认工作流 Agent 使用自身命名路由且 Child 工具拿不到父环境或文件凭据", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-env-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(path.join(directory, "runs"));
    await writeFile(
      path.join(directory, "leak-tool.mjs"),
      [
        "export default {",
        '  name: "leak_env",',
        '  description: "读取环境变量",',
        '  parameters: { type: "object", properties: {} },',
        "  execute: async () => ({",
        '    content: [{ type: "text", text: process.env.COREMIND_PROVIDER_AUTH ?? "missing" }],',
        "    details: {},",
        "  }),",
        "};",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(directory, ".env"),
      "WORKSPACE_SECRET=file-credential-value\n",
      "utf8",
    );
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
          model?: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        requests.push(payload as Record<string, unknown>);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        const toolNames = payload.tools?.map((tool) => tool.function?.name) ?? [];
        if (payload.model === "worker-model" && !hasToolResult) {
          sendSse(response, delegationResponseTo("reviewer", "call-workflow-reviewer"));
        } else if (payload.model === "reviewer-model" && !hasToolResult) {
          expect(toolNames).not.toContain("read");
          expect(toolNames).not.toContain("bash");
          expect(toolNames).not.toContain("leak_env");
          sendSse(response, textResponse("reviewer-env-final", "审查完成"));
        } else {
          sendSse(response, textResponse("worker-env-final", "工作流完成"));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "Delegation workflow environment",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_PROVIDER_AUTH",
        },
        agents: {
          main: { systemPrompt: "你是默认 Agent。" },
          worker: {
            systemPrompt: "你是工作 Agent。",
            model: "worker-model",
            tools: [
              { id: "read" },
              { id: "bash" },
              {
                path: "leak-tool.mjs",
                name: "leak_env",
                effect: { operations: ["read"], reversible: true },
              },
            ],
            delegation: {
              budget: { ...parentDelegationBudget(), wallTimeMs: 40_000, steps: 4 },
              limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
              targets: {
                reviewer: {
                  budget: {
                    tokens: 800,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 35_000,
                    steps: 3,
                    descendants: 0,
                  },
                },
              },
            },
          },
          reviewer: {
            systemPrompt: "你是审查 Agent。",
            model: "reviewer-model",
            tools: [
              { id: "read" },
              { id: "bash" },
              {
                path: "leak-tool.mjs",
                name: "leak_env",
                effect: { operations: ["read"], reversible: true },
              },
            ],
          },
        },
        defaultAgent: "main",
        workflow: [
          {
            id: "worker-delegates",
            type: "prompt",
            agent: "worker",
            input: "委派审查任务",
            saveAs: "workerResult",
          },
        ],
        runtime: {
          maxSteps: 6,
          maxToolCalls: 6,
          maxTokens: 3_000,
          maxCostUsd: 3,
          runTimeoutMs: 45_000,
        },
        permissions: { mode: "full", workspaceOnly: false, network: "allow" },
      };
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        env: {
          COREMIND_PROVIDER_AUTH: "provider-credential-value",
          UNRELATED_TOKEN: "unrelated-token-value",
          SAFE_FLAG: "visible",
          SENTRY_DSN: "sentry-credential-value",
          SSH_AUTH_SOCK: "ssh-agent-capability-value",
          SERVICE_AUTH: "custom-auth-value",
          PATH: process.env.PATH,
        },
        initialPrompt: "执行工作流",
        runStore: store,
      });

      const result = await runtime.run();
      const records = await store.read(result.runId);
      const serializedRequests = JSON.stringify(requests);
      const workerDelegationResultRequest = requests.find(
        (request) =>
          request.model === "worker-model" &&
          (request.messages as Array<{ role?: string }> | undefined)?.some(
            (message) => message.role === "tool",
          ),
      );
      const delegation = records.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );

      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
      expect(delegation?.payload).toMatchObject({
        budgetScope: "worker",
        agentName: "reviewer",
        model: { providerId: "probe", model: "reviewer-model" },
      });
      expect(JSON.stringify(workerDelegationResultRequest)).toContain(
        '\\"status\\":\\"succeeded\\"',
      );
      expect(serializedRequests).not.toContain("provider-credential-value");
      expect(serializedRequests).not.toContain("unrelated-token-value");
      expect(serializedRequests).not.toContain("sentry-credential-value");
      expect(serializedRequests).not.toContain("ssh-agent-capability-value");
      expect(serializedRequests).not.toContain("custom-auth-value");
      expect(serializedRequests).not.toContain("file-credential-value");
    } finally {
      await closeServer(server);
    }
  }, 45_000);

  it("未配置 delegation 时不向模型暴露工具且不产生 Child Fact", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-disabled-"));
    temporaryDirectories.push(directory);
    const requests: Array<{ tools?: Array<{ function?: { name?: string } }> }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body) as (typeof requests)[number]);
        sendSse(response, textResponse("disabled", "未委派"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: { systemPrompt: "你是父 Agent。" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "直接完成",
        runStore: store,
      });
      const result = await runtime.run();

      expect(
        requests.flatMap((request) => request.tools ?? []).map((tool) => tool.function?.name),
      ).not.toContain("delegate");
      expect(requests).toHaveLength(1);
      expect((await store.read(result.runId)).some((record) => record.kind === "delegation")).toBe(
        false,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("Delegation Approval 与 Child Tool Effect 分别审批并写入各自 Run Facts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-approval-"));
    temporaryDirectories.push(directory);
    const childOutputPath = "child-approval.txt";
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as {
          messages?: Array<{ role?: string }>;
        };
        const serializedMessages = JSON.stringify(payload.messages ?? []);
        const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
        const child = serializedMessages.includes("研究 Agent");
        if (hasToolResult) {
          sendSse(
            response,
            textResponse(
              child ? "child-approved" : "parent-approved",
              child ? "子任务完成" : "父任务完成",
            ),
          );
        } else if (child) {
          sendSse(
            response,
            writeToolResponse("call-child-approval-write", childOutputPath, "独立审批证据"),
          );
        } else {
          sendSse(response, delegationResponse());
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const approvals: ToolApprovalRequest[] = [];
      const store = new FileRunStore(path.join(directory, "runs"));
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...baseConfig(port, {
            main: {
              systemPrompt: "你是父 Agent。",
              tools: [{ id: "write" }],
              delegation: {
                budget: parentDelegationBudget(),
                targets: {
                  researcher: {
                    budget: {
                      tokens: 1_000,
                      toolCalls: 2,
                      costUsd: 1,
                      wallTimeMs: 5_000,
                      steps: 2,
                      descendants: 0,
                    },
                  },
                },
              },
            },
            researcher: { systemPrompt: "你是研究 Agent。", tools: [{ id: "write" }] },
          }),
          permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
        },
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "完成父任务",
        runStore: store,
        approveTool: async (request) => {
          approvals.push(request);
          return "allow";
        },
      });

      const result = await runtime.run();
      const childRunId = result.childRuns?.nodes[0]?.childRunId;
      const parentRecords = await store.read(result.runId);
      const delegation = parentRecords.find(
        (record) => record.kind === "delegation" && record.payload.type === "delegation_recorded",
      );
      const parentApprovals = result.trace
        .map((entry) => entry.event)
        .filter((event) => event.type === "approval_required");
      const parentResolvedApprovals = result.trace
        .map((entry) => entry.event)
        .filter((event) => event.type === "approval_resolved");
      const childEvents = childRunId
        ? (await store.read(childRunId)).flatMap((record) =>
            record.kind === "event" ? [(record.payload as CoreMindTraceEvent).event] : [],
          )
        : [];
      const childApprovals = childEvents.filter(
        (
          event,
        ): event is Extract<
          (typeof result.trace)[number]["event"],
          { type: "approval_required" }
        > =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "approval_required",
      );

      expect(
        result.outcome.status,
        JSON.stringify(
          {
            outcome: result.outcome,
            childRuns: result.childRuns?.nodes,
            approvals: approvals.map((request) => request.tool),
            childEvents,
          },
          null,
          2,
        ),
      ).toBe("succeeded");
      expect(approvals.map((request) => request.tool)).toEqual(["delegate", "write"]);
      expect(approvals[0]).toMatchObject({
        tool: "delegate",
        args: {
          target: "researcher",
          task: "研究已批准事实",
          references: [],
          limits: {
            tokens: 800,
            toolCalls: 2,
            costUsd: 1,
            wallTimeMs: 5_000,
            steps: 2,
            descendants: 0,
          },
        },
        argumentsFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        delegationInputFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      expect(approvals[0]?.delegationInputFingerprint).toBe(
        (delegation?.payload as { inputFingerprint?: string } | undefined)?.inputFingerprint,
      );
      expect(parentApprovals).toEqual([
        expect.objectContaining({
          tool: "delegate",
          argumentsFingerprint: approvals[0]?.argumentsFingerprint,
          delegationInputFingerprint: approvals[0]?.delegationInputFingerprint,
        }),
      ]);
      expect(parentResolvedApprovals).toEqual([
        expect.objectContaining({
          decision: "allow",
          argumentsFingerprint: approvals[0]?.argumentsFingerprint,
          delegationInputFingerprint: approvals[0]?.delegationInputFingerprint,
        }),
      ]);
      expect(childApprovals).toEqual([
        expect.objectContaining({
          tool: "write",
          argumentsFingerprint: approvals[1]?.argumentsFingerprint,
        }),
      ]);
      expect(approvals[1]?.argumentsFingerprint).not.toBe(approvals[0]?.argumentsFingerprint);
      await expect(readFile(path.join(directory, childOutputPath), "utf8")).resolves.toBe(
        "独立审批证据",
      );
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    ["未预批准", false, 1],
    ["显式预批准", true, 0],
  ] as const)(
    "assisted 模式%s Target 的委派审批次数正确",
    async (_label, preapproved, expected) => {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-assisted-"));
      temporaryDirectories.push(directory);
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const payload = JSON.parse(body) as {
            messages?: Array<{ role?: string }>;
            tools?: Array<{ function?: { name?: string } }>;
          };
          const hasToolResult =
            payload.messages?.some((message) => message.role === "tool") ?? false;
          const hasDelegationTool =
            payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
          if (hasToolResult) sendSse(response, textResponse("assisted-parent", "父任务完成"));
          else if (hasDelegationTool) sendSse(response, delegationResponse());
          else sendSse(response, textResponse("assisted-child", "子任务完成"));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

      try {
        const approvals: ToolApprovalRequest[] = [];
        const port = (server.address() as AddressInfo).port;
        const runtime = await CoreMindRuntime.create({
          config: {
            ...baseConfig(port, {
              main: {
                systemPrompt: "你是父 Agent。",
                delegation: {
                  budget: parentDelegationBudget(),
                  targets: {
                    researcher: {
                      ...(preapproved ? { preapproved: true } : {}),
                      budget: {
                        tokens: 1_000,
                        toolCalls: 2,
                        costUsd: 1,
                        wallTimeMs: 5_000,
                        steps: 2,
                        descendants: 0,
                      },
                    },
                  },
                },
              },
              researcher: { systemPrompt: "你是研究 Agent。" },
            }),
            permissions: { mode: "assisted", workspaceOnly: true, network: "deny" },
          },
          configDir: directory,
          cwd: directory,
          env: { COREMIND_TEST_API_KEY: "test-key" },
          initialPrompt: "完成父任务",
          runStore: new FileRunStore(path.join(directory, "runs")),
          approveTool: async (request) => {
            approvals.push(request);
            return "allow";
          },
        });

        const result = await runtime.run();
        expect(result.outcome.status).toBe("succeeded");
        expect(approvals.filter((request) => request.tool === "delegate")).toHaveLength(expected);
      } finally {
        await closeServer(server);
      }
    },
  );

  it.each([
    ["非 allowlist Agent", '{"target":"auditor","task":"越权委派"}'],
    [
      "内联权限覆盖",
      '{"target":"researcher","task":"越权委派","provider":"other","permissions":{"mode":"full"}}',
    ],
    ["超过 Config 的预算", '{"target":"researcher","task":"越权委派","limits":{"tokens":1200}}'],
  ])("拒绝%s，并且不先写入 Child Fact", async (_label, argumentsJson) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-reject-"));
    temporaryDirectories.push(directory);
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { messages?: Array<{ role?: string }> };
        if (payload.messages?.some((message) => message.role === "tool")) {
          sendSse(response, textResponse("rejected-final", "拒绝后收口"));
          return;
        }
        sendSse(response, toolCallResponse(argumentsJson));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: parentDelegationBudget(),
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 5_000,
                    steps: 2,
                    descendants: 0,
                  },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。" },
          auditor: { systemPrompt: "你是未授权审计 Agent。" },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "尝试委派",
        runStore: store,
      });
      const result = await runtime.run();
      const records = await store.read(result.runId);

      expect(records.some((record) => record.kind === "delegation")).toBe(false);
      expect(result.outcome.status).toBe("failed");
      expect(result.outcome.error?.code).toBe("child_run_policy_escalation");
    } finally {
      await closeServer(server);
    }
  });

  it("目标 Agent 的工具超出父 Agent authority 时在 Child Fact 前拒绝", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-tools-"));
    temporaryDirectories.push(directory);
    const server = createServer((_request, response) => {
      sendSse(response, toolCallResponse('{"target":"researcher","task":"尝试扩大工具权限"}'));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = new FileRunStore(path.join(directory, "runs"));
      const runtime = await CoreMindRuntime.create({
        config: baseConfig((server.address() as AddressInfo).port, {
          main: {
            systemPrompt: "你是父 Agent。",
            delegation: {
              budget: parentDelegationBudget(),
              targets: {
                researcher: {
                  budget: {
                    tokens: 1_000,
                    toolCalls: 2,
                    costUsd: 1,
                    wallTimeMs: 5_000,
                    steps: 2,
                    descendants: 0,
                  },
                },
              },
            },
          },
          researcher: { systemPrompt: "你是研究 Agent。", tools: [{ id: "web-fetch" }] },
        }),
        configDir: directory,
        cwd: directory,
        env: { COREMIND_TEST_API_KEY: "test-key" },
        initialPrompt: "尝试委派",
        runStore: store,
      });
      const result = await runtime.run();
      const records = await store.read(result.runId);

      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "child_run_policy_escalation" },
      });
      expect(records.some((record) => record.kind === "delegation")).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("父 Run 未活动时拒绝独立委派入口", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-delegation-inactive-"));
    temporaryDirectories.push(directory);
    const runtime = await CoreMindRuntime.create({
      config: baseConfig(1, {
        main: { systemPrompt: "你是父 Agent。" },
      }),
      configDir: directory,
      cwd: directory,
      env: { COREMIND_TEST_API_KEY: "test-key" },
    });

    await expect(runtime.delegateChildRun({} as never)).rejects.toMatchObject({
      code: "child_run_unavailable",
    });
  });
});

async function within<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function eventually<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label);
}

function baseConfig(port: number, agents: CoreMindConfig["agents"]): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "Delegation acceptance",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents,
    defaultAgent: "main",
    runtime: {
      maxSteps: 4,
      maxToolCalls: 4,
      maxTokens: 2_000,
      maxCostUsd: 2,
      runTimeoutMs: 10_000,
    },
    permissions: { mode: "full", workspaceOnly: true, network: "allow" },
  };
}

function parentDelegationBudget() {
  return {
    tokens: 1_000,
    toolCalls: 2,
    costUsd: 1,
    wallTimeMs: 5_000,
    steps: 2,
    descendants: 1,
  };
}

function delegationResponse(): unknown[] {
  return [
    {
      id: "parent-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-delegate",
                type: "function",
                function: {
                  name: "delegate",
                  arguments:
                    '{"target":"researcher","task":"研究已批准事实","references":[],"limits":{"tokens":800,"maxDepth":1,"maxActiveChildren":0}}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "parent-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function delegationResponseTo(
  target: string,
  callId: string,
  references: string[] = [],
): unknown[] {
  return toolCallResponse(
    JSON.stringify({ target, task: `委派给 ${target}`, references, limits: {} }),
  ).map((chunk) => {
    const cloned = structuredClone(chunk) as {
      choices?: Array<{ delta?: { tool_calls?: Array<{ id?: string }> } }>;
    };
    const toolCall = cloned.choices?.[0]?.delta?.tool_calls?.[0];
    if (toolCall) toolCall.id = callId;
    return cloned;
  });
}

function toolCallResponse(argumentsJson: string): unknown[] {
  return [
    {
      id: "invalid-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-invalid-delegate",
                type: "function",
                function: { name: "delegate", arguments: argumentsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "invalid-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function namedToolCallResponse(
  name: string,
  args: Record<string, unknown>,
  callId: string,
): unknown[] {
  return [
    {
      id: `tool-${callId}`,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: `tool-${callId}`,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function delegationIdsFromToolMessages(
  messages: Array<{ role?: string; content?: unknown }> | undefined,
): string[] {
  const delegationIds: string[] = [];
  for (const message of messages ?? []) {
    if (message.role !== "tool" || typeof message.content !== "string") continue;
    try {
      const result = JSON.parse(message.content) as {
        delegationId?: unknown;
        result?: unknown;
      };
      if (typeof result.delegationId === "string" && "result" in result) {
        delegationIds.push(result.delegationId);
      }
    } catch {
      // 其他工具结果不是结构化委派结果，忽略。
    }
  }
  return delegationIds;
}

function writeToolResponse(callId: string, targetPath: string, content: string): unknown[] {
  return [
    {
      id: "child-workspace-write",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ path: targetPath, content }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "child-workspace-write",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function parentWriterAndDelegationResponse(): unknown[] {
  return [
    {
      id: "parent-writer-race",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-parent-held-write",
                type: "function",
                function: {
                  name: "held_write",
                  arguments: JSON.stringify({ path: "parent.txt", content: "不应写入" }),
                },
              },
              {
                index: 1,
                id: "call-parent-delegate",
                type: "function",
                function: {
                  name: "delegate",
                  arguments: JSON.stringify({
                    target: "writer",
                    task: "尝试覆盖 protected.txt",
                    references: [],
                    limits: {},
                  }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "parent-writer-race",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function siblingDelegationResponse(): unknown[] {
  const delegation = (index: number, callId: string, task: string) => ({
    index,
    id: callId,
    type: "function",
    function: {
      name: "delegate",
      arguments: JSON.stringify({
        target: "writer",
        task,
        references: [],
        limits: { tokens: 800, descendants: 0, maxDepth: 1, maxActiveChildren: 0 },
      }),
    },
  });
  return [
    {
      id: "sibling-delegations",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              delegation(0, "call-delegate-sibling-a", "写入 sibling-a.txt"),
              delegation(1, "call-delegate-sibling-b", "写入 sibling-b.txt"),
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "sibling-delegations",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function textResponse(id: string, text: string): unknown[] {
  return [
    {
      id,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
