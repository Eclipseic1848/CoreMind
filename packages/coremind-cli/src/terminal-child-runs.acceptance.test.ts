import "../../../test/setup-env.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ChatSession,
  type CoreMindConfig,
  type CoreMindEvent,
  CoreMindRuntime,
  type CoreMindTraceEvent,
  FileRunStore,
  ProjectionEngine,
  type ToolApprovalRequest,
} from "coremind-ai";
import { expect, it } from "vitest";
import { createTerminalView, foldTerminalView } from "./terminal-view.js";

const sharedCallId = "same-child-write";
const targets = [
  { path: "child-a.md", content: "第一位真实 Child 写入正文" },
  { path: "child-b.md", content: "第二位真实 Child 写入正文" },
] as const;

interface ModelRequest {
  model: string;
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

it("同一 chat 委派两位同名 Child 时，真实 Trace 来源隔离同 Call 的审批、耗时与结果", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-terminal-child-runs-"));
  assert(path.dirname(path.resolve(directory)) === path.resolve(tmpdir()));
  assert(path.basename(directory).startsWith("coremind-terminal-child-runs-"));
  const store = new FileRunStore(path.join(directory, "runs"));
  const requests: ModelRequest[] = [];
  const failures: unknown[] = [];
  const approvals: ToolApprovalRequest[] = [];
  const oracle: CoreMindTraceEvent[] = [];
  const live: Array<{ event: CoreMindEvent; entry?: CoreMindTraceEvent }> = [];
  let view = foldTerminalView(createTerminalView(), { type: "begin", epoch: 1 });
  let parentRequests = 0;
  let childStarts = 0;
  let session: ChatSession | undefined;
  let running: ReturnType<ChatSession["chat"]> | undefined;
  const model = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(text) as ModelRequest;
        requests.push(body);
        if (body.model === "worker-model") {
          expect(body.tools?.map((tool) => tool.function.name)).toEqual(["write"]);
          const completed = body.messages.some((message) => message.role === "tool");
          if (completed) sendText(response, "Child 已实际写入");
          else {
            const target = targets[childStarts++];
            assert(target, "只允许两个真正 Child 首次请求");
            expect(JSON.stringify(body.messages)).toContain(target.path);
            sendCall(response, sharedCallId, "write", target);
          }
          return;
        }
        expect(body.model).toBe("parent-model");
        expect(body.tools?.some((tool) => tool.function.name === "delegate")).toBe(true);
        parentRequests++;
        if (parentRequests <= 2) {
          const target = targets[parentRequests - 1]!;
          sendCall(response, `parent-delegate-${parentRequests}`, "delegate", {
            target: "worker",
            task: `将“${target.content}”写入 ${target.path}，然后结束。`,
            references: [],
            limits: { maxDepth: 1, maxActiveChildren: 0 },
          });
        } else {
          expect(parentRequests).toBe(3);
          sendText(response, "两次真实委派均完成");
        }
      } catch (error) {
        failures.push(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", resolve);
    });
    const allocation = {
      tokens: 4_000,
      toolCalls: 1,
      costUsd: 0.5,
      wallTimeMs: 8_000,
      steps: 2,
      descendants: 0,
    };
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "真实 Child 来源身份验收",
      provider: {
        id: "probe",
        model: "parent-model",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
        baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
      },
      agents: {
        main: {
          systemPrompt: "你是父 Agent，只按顺序委派两个独立任务。",
          tools: [{ id: "write" }],
          delegation: {
            budget: {
              tokens: 12_000,
              toolCalls: 4,
              costUsd: 2,
              wallTimeMs: 25_000,
              steps: 6,
              descendants: 2,
            },
            limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 2 },
            targets: { worker: { budget: allocation } },
          },
        },
        worker: {
          systemPrompt: "你是写入 Child，严格只完成委派给你的文件。",
          model: "worker-model",
          tools: [{ id: "write" }],
        },
      },
      defaultAgent: "main",
      runtime: {
        maxTurns: 8,
        maxSteps: 8,
        maxTokens: 30_000,
        maxToolCalls: 8,
        maxCostUsd: 5,
        maxRetries: 0,
        runTimeoutMs: 30_000,
      },
      permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    };
    const runtime = await CoreMindRuntime.create({
      config,
      cwd: directory,
      configDir: directory,
      env: { COREMIND_TEST_API_KEY: "offline-test-only" },
      runStore: store,
      trace: (entry) => {
        oracle.push(structuredClone(entry));
      },
      approveTool: async (request) => {
        approvals.push(structuredClone(request));
        return "allow";
      },
    });
    session = new ChatSession(runtime, "main");
    const unsubscribe = session.onEvent((event: CoreMindEvent, entry?: CoreMindTraceEvent) => {
      live.push({
        event: structuredClone(event),
        ...(entry ? { entry: structuredClone(entry) } : {}),
      });
      // runId 只能来自同次真实回调，不得用 oracle 或审批字段填补缺失来源。
      const action = {
        type: "event" as const,
        epoch: 1,
        event,
        runId: entry?.runId,
        observedAtMs: performance.now(),
      };
      view = foldTerminalView(view, action);
    });
    try {
      running = session.chat("依次委派 worker 写入两个独立文件。");
      const result = await running;
      expect(failures).toEqual([]);
      expect(result.run.outcome, JSON.stringify(result.run.outcome)).toMatchObject({
        status: "succeeded",
      });
      expect(parentRequests).toBe(3);
      expect(childStarts).toBe(2);
      expect(requests).toHaveLength(7);
      const nodes = result.run.childRuns?.nodes ?? [];
      expect(nodes).toHaveLength(2);
      expect(new Set(nodes.map((node) => node.childRunId)).size).toBe(2);
      expect(
        nodes.every(
          (node) =>
            node.agentName === "worker" &&
            node.status === "joined" &&
            node.outcome?.status === "succeeded",
        ),
      ).toBe(true);
      for (const target of targets)
        expect(await readFile(path.join(directory, target.path), "utf8")).toBe(target.content);

      const parent = ProjectionEngine.project(await store.read(result.run.runId));
      expect(parent.outcome?.status).toBe("succeeded");
      const childEvidence = [];
      for (const node of nodes) {
        const records = await store.read(node.childRunId);
        const projection = ProjectionEngine.project(records);
        expect(projection.outcome?.status).toBe("succeeded");
        const events = projection.trace.map((entry) => entry.event);
        const calls = events.filter(
          (event) => event.type === "tool_call" && event.tool === "write",
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ agent: "worker", callId: sharedCallId });
        expect(Object.hasOwn(calls[0]!, "stepId")).toBe(false);
        const evidence = events.find(
          (event) => event.type === "tool_execution_evidence" && event.callId === sharedCallId,
        );
        assert(evidence?.type === "tool_execution_evidence");
        expect(evidence.execution.durationMs).toBeGreaterThanOrEqual(0);
        const required = events.filter(
          (event) => event.type === "approval_required" && event.tool === "write",
        );
        expect(required).toHaveLength(1);
        const approval = required[0];
        assert(approval?.type === "approval_required");
        expect(approval).toMatchObject({
          runId: node.childRunId,
          agent: "worker",
          callId: sharedCallId,
        });
        expect(
          approvals.find((request) => request.approvalId === approval.approvalId),
        ).toMatchObject({
          runId: node.childRunId,
          agent: "worker",
          callId: sharedCallId,
          tool: "write",
        });
        expect(events.filter((event) => event.type === "approval_resolved")).toEqual([
          expect.objectContaining({
            runId: node.childRunId,
            approvalId: approval.approvalId,
            decision: "allow",
          }),
        ]);
        expect(
          events
            .filter((event) => event.type === "effect_receipt" && event.callId === sharedCallId)
            .map((event) => (event.type === "effect_receipt" ? event.status : undefined)),
        ).toEqual(["started", "committed"]);
        expect(events.filter((event) => event.type === "artifact_created")).toEqual([]);
        expect(oracle.filter((entry) => entry.runId === node.childRunId)).toEqual(projection.trace);
        childEvidence.push({
          runId: node.childRunId,
          evidence: evidence.execution,
          approvalId: approval.approvalId,
        });
      }

      expect.soft(live).toHaveLength(oracle.length);
      expect
        .soft(
          live.filter(({ entry }) => entry === undefined).length,
          "所有 Trace 实时事件都须携原 envelope 来源",
        )
        .toBe(0);
      const byIdentity = new Map(
        oracle.map((entry) => [
          JSON.stringify([entry.runId, entry.eventId, entry.sequence]),
          entry,
        ]),
      );
      expect(byIdentity.size).toBe(oracle.length);
      for (const notification of live) {
        if (!notification.entry) continue;
        const { entry, event } = notification;
        expect(entry).toEqual(
          byIdentity.get(JSON.stringify([entry.runId, entry.eventId, entry.sequence])),
        );
        expect(event).toEqual(entry.event);
      }
      view = foldTerminalView(view, { type: "end", epoch: 1, runId: result.run.runId });
      const rows = view.rows.filter(
        (row) =>
          row.kind === "tool" && row.call.agent === "worker" && row.call.callId === sharedCallId,
      );
      expect.soft(rows, "两个真正 Child 的同名同 Call 不得在同一 chat epoch 合并").toHaveLength(2);
      for (const child of childEvidence) {
        const row = rows.find((candidate) => candidate.runId === child.runId);
        expect.soft(row, `Child ${child.runId} 必须保留自己的完整来源`).toMatchObject({
          runId: child.runId,
          tool: "write",
          call: { agent: "worker", callId: sharedCallId },
          execution: child.evidence,
          resultReceived: true,
          isError: false,
          result: { executionOutcome: "returned", effectState: "committed" },
          approval: { approvalId: child.approvalId, decision: "allow" },
        });
      }
      const parentRows = view.rows.filter(
        (row) => row.kind === "tool" && row.call.agent === "main",
      );
      expect(parentRows).toHaveLength(2);
      expect(parentRows.every((row) => row.runId === result.run.runId)).toBe(true);
    } finally {
      unsubscribe();
    }
  } finally {
    session?.abort();
    await running?.catch(() => {});
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}, 40_000);

function sendCall(response: ServerResponse, id: string, name: string, args: unknown): void {
  send(
    response,
    {
      role: "assistant",
      tool_calls: [
        { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
    "tool_calls",
  );
}

function sendText(response: ServerResponse, text: string): void {
  send(response, { role: "assistant", content: text }, "stop");
}

function send(response: ServerResponse, delta: unknown, finish: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [content, reason] of [
    [delta, null],
    [{}, finish],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "terminal-child-source", choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
