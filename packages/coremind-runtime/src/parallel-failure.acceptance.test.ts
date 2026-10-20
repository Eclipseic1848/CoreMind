import "../../../test/setup-env.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { AgentDriver } from "./agent-driver.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { Orchestrator } from "./orchestrator.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

it.each(["retry_exhausted", "loop_paused"] as const)(
  "%s 取消嵌套兄弟并等待清理，清理错误不覆盖首错",
  async (code) => {
    const original = new CoreMindError(code, "首个失败");
    let start!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    let stop!: () => void;
    let cleaned = false;
    const cleanup = new Promise<void>((resolve) => {
      stop = resolve;
    }).then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      cleaned = true;
      throw new Error("兄弟清理失败");
    });
    const slow = {
      prompt: () => {
        start();
        return cleanup;
      },
      waitForIdle: async () => {},
      abort: stop,
      messages: () => [],
      status: () => ({ running: false, pendingToolCalls: 0, queuedControls: 0 }),
      canAcceptControl: () => false,
      queueControl: () => {},
      clearQueuedControls: () => {},
    } satisfies AgentDriver;
    const fast: AgentDriver = {
      ...slow,
      prompt: async () => {
        await started;
        throw original;
      },
      abort: () => {},
    };
    const orchestrator = new Orchestrator(
      [
        {
          id: "group",
          type: "parallel",
          steps: [
            { id: "fast", type: "prompt", agent: "fast", input: "fail" },
            {
              id: "nested",
              type: "if",
              condition: "true",
              then: [{ id: "slow", type: "prompt", agent: "slow", input: "wait" }],
            },
          ],
        },
      ],
      {
        createAgent: (name) => (name === "fast" ? fast : slow),
        events: () => {},
      },
    );
    try {
      await expect(orchestrator.run()).rejects.toBe(original);
      expect(cleaned).toBe(true);
    } finally {
      stop();
      await cleanup.catch(() => {});
    }
  },
);

it.each([
  ["fatal", false, false],
  ["paused", false, false],
  ["fatal", true, false],
  ["paused", true, false],
  ["fatal", true, true],
  ["paused", true, true],
] as const)(
  "并行 %s 首败收回兄弟请求，返回后不再执行迟到片段（在飞工具：%s，待审批：%s）",
  async (failure, activeTool, awaitingApproval) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-parallel-failure-"));
    let slow: ServerResponse | undefined;
    let slowStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      slowStarted = resolve;
    });
    let requests = 0;
    let approvals = 0;
    let toolSettled = false;
    let releaseTool = () => {};
    let releaseApproval = () => {};
    const events: CoreMindEvent[] = [];
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests += 1;
      if (JSON.stringify(body.messages.at(-1)?.content).includes("slow")) {
        slow = res;
        if (activeTool) {
          send(res, [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "pending-write",
                    type: "function",
                    function: {
                      name: "pending_write",
                      arguments: JSON.stringify({ path: "business.txt" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ]);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": waiting\n\n");
        slowStarted();
        return;
      }
      await ready;
      if (failure === "paused") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "simulated input rejected" } }));
        return;
      }
      send(res, [{ delta: { role: "assistant", content: "BAD" }, finish_reason: "stop" }]);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new FileRunStore(path.join(cwd, "runs"));
    try {
      const runtime = await CoreMindRuntime.create({
        cwd,
        configDir: cwd,
        runStore: store,
        approveTool: async () => {
          approvals += 1;
          if (awaitingApproval) {
            slowStarted();
            return new Promise<"allow">((resolve) => {
              releaseApproval = () => resolve("allow");
            });
          }
          return "allow";
        },
        events: (event) => events.push(event),
        toolDefinitions: activeTool
          ? [
              {
                name: "pending_write",
                description: "等待取消并完成收尾的本地写入",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
                effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
                execute: async (_args, { signal }) => {
                  writeFileSync(path.join(cwd, "business.txt"), "committed", "utf8");
                  slowStarted();
                  await new Promise<void>((resolve) => {
                    releaseTool = resolve;
                    if (signal?.aborted) resolve();
                    else signal?.addEventListener("abort", () => resolve(), { once: true });
                  });
                  await new Promise((resolve) => setTimeout(resolve, 10));
                  toolSettled = true;
                  return { text: "committed" };
                },
              },
            ]
          : [],
        config: {
          schemaVersion: 2,
          name: "parallel-failure",
          provider: {
            id: "probe",
            model: "probe",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
          },
          agents: { main: {} },
          tools: [{ id: "write" }],
          permissions: {
            mode: awaitingApproval ? "ask" : "full",
            workspaceOnly: true,
            network: "deny",
          },
          runtime: { maxTurns: 4, maxRetries: 0, runTimeoutMs: awaitingApproval ? 3000 : 10_000 },
          workflow: [
            {
              id: "parallel",
              type: "parallel",
              steps: [
                {
                  id: "fast",
                  type: "prompt",
                  agent: "main",
                  input: "fast",
                  retry: { if: "true", max: 0 },
                },
                { id: "slow", type: "prompt", agent: "main", input: "slow" },
              ],
            },
          ],
        },
      });
      const result = await runtime.run();
      expect(result.outcome.status).toBe(failure === "fatal" ? "failed" : "paused");
      if (failure === "fatal") expect(result.outcome.error?.code).toBe("retry_exhausted");
      const cursor = events.length;
      const records = await store.read(result.runId);
      const quiescent = await runtime.waitForQuiescence(1000);
      releaseApproval();
      if (!activeTool)
        send(slow!, [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "late-write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ path: "late.txt", content: "late" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(quiescent).toBe(true);
      expect(requests).toBe(2);
      expect(approvals).toBe(awaitingApproval ? 1 : 0);
      if (awaitingApproval) {
        expect(toolSettled).toBe(false);
        expect(existsSync(path.join(cwd, "business.txt"))).toBe(false);
        expect(
          result.trace.flatMap(({ event }) =>
            event.type === "approval_resolved" ? [event.decision] : [],
          ),
        ).toEqual(["deny"]);
      } else if (activeTool) {
        expect(toolSettled).toBe(true);
        const receipts = result.trace.flatMap(({ event }) =>
          event.type === "effect_receipt" && event.tool === "pending_write" ? [event] : [],
        );
        expect(receipts.some((receipt) => receipt.status === "started")).toBe(true);
        expect(["committed", "unknown"]).toContain(receipts.at(-1)?.status);
      }
      expect(existsSync(path.join(cwd, "late.txt"))).toBe(false);
      expect(events.slice(cursor)).toEqual([]);
      expect(await store.read(result.runId)).toEqual(records);
      expect(records.at(-1)?.kind).toBe(failure === "fatal" ? "finish" : "pause");
    } finally {
      releaseApproval();
      releaseTool();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

function send(res: ServerResponse, choices: unknown[]): void {
  if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const choice of choices)
    res.write(
      `data: ${JSON.stringify({ id: "test", choices: [{ index: 0, ...(choice as object) }] })}\n\n`,
    );
  res.end("data: [DONE]\n\n");
}
