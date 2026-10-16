import "../../../test/setup-env.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, vi } from "vitest";
import { validateEffectReceiptBindingsAgainstFacts } from "./effect-receipt-binding.js";
import type { CoreMindEvent } from "./events.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";

type Mode = "single" | "workflow" | "loop";
const partial = "保留的部分正文";

describe("模型输出上限的真实 Runtime 合同", () => {
  it.for(["single", "workflow", "loop"] as const)(
    "%s 截断保留正文且不重试、不继续",
    async (mode, context) => {
      const fixture = await runFixture(mode, "length", context.signal);
      expect(fixture.result.outcome).toMatchObject({
        status: "failed",
        finishReason: "model_output_limit",
        error: { code: "model_output_limit" },
      });
      expect(fixture.result.snapshot.outcome).toEqual(fixture.result.outcome);
      expect(fixture.result.transcript).toBe(partial);
      expect(fixture.result.messages.get("main")?.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "length",
      });
      expect(JSON.stringify(fixture.result.messages.get("main"))).toContain(partial);
      expect(
        fixture.events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe(partial);
      expect(fixture.requests).toHaveLength(1);
      expect(
        fixture.events.some((event) => event.type === "retry" || event.type === "input_completed"),
      ).toBe(false);
      expect(fixture.events.some((event) => event.type === "input_discarded")).toBe(true);
      expect(
        fixture.events.some((event) => event.type === "step_start" && event.stepId === "never"),
      ).toBe(false);
      expect(
        fixture.events.some(
          (event) =>
            event.type === "loop_state" && (event.to === "verifying" || event.to === "repairing"),
        ),
      ).toBe(false);
      expect(fixture.verifications).toBe(0);
      expect(fixture.records.at(-1)).toMatchObject({
        kind: "finish",
        payload: { outcome: fixture.result.outcome },
      });
      expect(fixture.records.map((record) => record.sequence)).toEqual(
        fixture.records.map((_, index) => index + 1),
      );
    },
  );

  it.for(["single", "workflow", "loop"] as const)(
    "%s 截断附完整 write 参数也仅一请求且零审批执行",
    async (mode, context) => {
      const fixture = await runFixture(mode, "length", context.signal, true);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.result.outcome).toMatchObject({
        status: "failed",
        finishReason: "model_output_limit",
        error: { code: "model_output_limit" },
      });
      expect(fixture.result.snapshot.outcome).toEqual(fixture.result.outcome);
      expect(fixture.result.transcript).toBe(partial);
      expect(fixture.fileContent).toBe("原始完整正文");
      expect(fixture.approvalCount).toBe(0);
      const lastAssistant = [...(fixture.result.messages.get("main") ?? [])]
        .reverse()
        .find((message) => message.role === "assistant");
      expect(lastAssistant).toMatchObject({ stopReason: "length" });
      expect(JSON.stringify(lastAssistant)).toContain(partial);
      expect(
        fixture.events
          .filter((event) => event.type === "text_delta")
          .map((event) => event.delta)
          .join(""),
      ).toBe(partial);
      expect(
        fixture.events.some(
          (event) =>
            event.type === "checkpoint_created" ||
            event.type === "retry" ||
            event.type === "input_completed",
        ),
      ).toBe(false);
      expect(
        fixture.events.some(
          (event) =>
            event.type === "tool_lifecycle" &&
            event.resolution.phase === "executing" &&
            event.resolution.status === "completed",
        ),
      ).toBe(false);
      expect(
        fixture.events.some((event) => event.type === "step_start" && event.stepId === "never"),
      ).toBe(false);
      expect(
        fixture.events.some(
          (event) =>
            event.type === "loop_state" && (event.to === "verifying" || event.to === "repairing"),
        ),
      ).toBe(false);
      expect(fixture.verifications).toBe(0);
      expect(
        validateEffectReceiptBindingsAgainstFacts(fixture.result.runId, fixture.events),
      ).toEqual([
        expect.objectContaining({
          status: "not_started",
          provenance: "bound",
          binding: expect.objectContaining({
            runId: fixture.result.runId,
            agent: "main",
            tool: "write",
            callId: "call-truncated",
          }),
        }),
      ]);
      expect(fixture.events).toContainEqual(
        expect.objectContaining({
          type: "tool_lifecycle",
          callId: "call-truncated",
          resolution: expect.objectContaining({
            phase: "observed",
            status: "skipped",
            result: expect.objectContaining({
              executionOutcome: "not_invoked",
              effectState: "not_started",
            }),
          }),
        }),
      );
      expect(fixture.records.at(-1)).toMatchObject({
        kind: "finish",
        payload: { outcome: fixture.result.outcome },
      });
      expect(fixture.records.map((record) => record.sequence)).toEqual(
        fixture.records.map((_, index) => index + 1),
      );
    },
  );

  it("合法 write 经真实审批和 Registry 写入后，正常 stop 仍成功", async (context) => {
    const fixture = await runFixture("single", "stop", context.signal, true);
    expect(fixture.requests).toHaveLength(2);
    const firstRequest = fixture.requests[0] as {
      tools?: Array<{ type?: string; function?: { name?: string } }>;
    };
    expect(firstRequest.tools).toContainEqual(
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "write" }),
      }),
    );
    expect(fixture.result.outcome).toEqual({ status: "succeeded", finishReason: "completed" });
    expect(fixture.result.snapshot.outcome).toEqual(fixture.result.outcome);
    expect(fixture.fileContent).toBe("完整新正文");
    expect(fixture.approvalCount).toBe(1);
    expect(fixture.result.messages.get("main")?.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(fixture.result.transcript).toContain("工具调用后正常完成");
    expect(validateEffectReceiptBindingsAgainstFacts(fixture.result.runId, fixture.events)).toEqual(
      [
        expect.objectContaining({
          status: "committed",
          provenance: "bound",
          binding: expect.objectContaining({
            runId: fixture.result.runId,
            agent: "main",
            tool: "write",
            callId: "call-truncated",
          }),
        }),
      ],
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        tool: "write",
        callId: "call-truncated",
        isError: false,
      }),
    );
    expect(fixture.events.some((event) => event.type === "checkpoint_created")).toBe(true);
    expect(
      fixture.events.some(
        (event) =>
          event.type === "tool_lifecycle" &&
          event.resolution.phase === "executing" &&
          event.resolution.status === "completed",
      ),
    ).toBe(true);
    expect(fixture.events.some((event) => event.type === "input_completed")).toBe(true);
    expect(fixture.records.at(-1)).toMatchObject({
      kind: "finish",
      payload: { outcome: fixture.result.outcome },
    });
    expect(fixture.records.map((record) => record.sequence)).toEqual(
      fixture.records.map((_, index) => index + 1),
    );
  });

  it("正常 stop 仍成功并保留原正文和停止原因", async (context) => {
    const fixture = await runFixture("single", "stop", context.signal);
    expect(fixture.result.outcome).toEqual({ status: "succeeded", finishReason: "completed" });
    expect(fixture.result.transcript).toBe(partial);
    expect(fixture.result.messages.get("main")?.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.events.some((event) => event.type === "input_completed")).toBe(true);
  });
});

async function runFixture(
  mode: Mode,
  stopReason: "length" | "stop",
  testSignal: AbortSignal,
  withWriteCall = false,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-output-limit-"));
  const target = path.join(directory, "article.md");
  const approve = vi.fn(async () => "allow" as const);
  const controller = new AbortController();
  const events: CoreMindEvent[] = [];
  const requests: unknown[] = [];
  const replies: Promise<unknown>[] = [];
  let verifications = 0;
  let runtime: CoreMindRuntime | undefined;
  let running: Promise<RunResult> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        response.writeHead(400).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const first = requests.length === 1;
      const chunks = [
        {
          id: "limit",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: first || !withWriteCall ? partial : "工具调用后正常完成",
              },
              finish_reason: null,
            },
          ],
        },
        ...(withWriteCall && first
          ? [
              {
                id: "limit",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-truncated",
                          type: "function",
                          function: {
                            name: "write",
                            arguments: JSON.stringify({
                              path: "article.md",
                              content: "完整新正文",
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
            ]
          : []),
        {
          id: "limit",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: withWriteCall
                ? first
                  ? stopReason === "length"
                    ? "length"
                    : "tool_calls"
                  : "stop"
                : stopReason,
            },
          ],
        },
      ];
      for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  const abort = () => {
    controller.abort();
    server.closeAllConnections();
  };
  testSignal.addEventListener("abort", abort, { once: true });
  try {
    if (testSignal.aborted) abort();
    controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (withWriteCall) await writeFile(target, "原始完整正文", "utf8");
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "单次模型输出上限验收",
      provider: {
        id: "probe",
        model: "probe-model",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      agents: { main: { tools: withWriteCall ? [{ id: "write" }] : [] } },
      ...(withWriteCall
        ? {
            tools: [{ id: "write" }],
            permissions: { mode: "ask" as const, workspaceOnly: true, network: "allow" as const },
          }
        : {}),
      session: { enabled: false },
      runtime: { maxTurns: 4, maxRetries: 2, runTimeoutMs: 6_000 },
      ...(mode === "workflow"
        ? {
            workflow: [
              { id: "first", type: "prompt" as const, agent: "main", input: "生成候选" },
              { id: "never", type: "prompt" as const, agent: "main", input: "后继不得执行" },
            ],
          }
        : {}),
      ...(mode === "loop"
        ? {
            loop: {
              execute: { agent: "main", input: "执行 {{prompt}}" },
              verify: { mode: "host" as const, timeoutMs: 1_000 },
              repair: { agent: "main", input: "修正 {{verification.text}}" },
              maxIterations: 1,
              maxRepairs: 0,
              onFailure: "fail" as const,
              onExhausted: "fail" as const,
            },
          }
        : {}),
    };
    const store = new FileRunStore(path.join(directory, "runs"));
    runtime = await CoreMindRuntime.create({
      config,
      configDir: directory,
      cwd: directory,
      runStore: store,
      env: { COREMIND_TEST_API_KEY: "test-only" },
      ...(withWriteCall ? { approveTool: approve } : {}),
      initialPrompt: "验证截断",
      signal: controller.signal,
      events: (event) => events.push(event),
      onVerification: (request) => {
        verifications++;
        // 旧行为如误入验收，立即批准以暴露假成功，避免以等待超时代替根因断言。
        const reply = runtime!.acceptControl({
          schemaVersion: 1,
          type: "verification",
          controlId: `reply-${request.requestId}`,
          runId: request.runId,
          requestId: request.requestId,
          candidateSha256: request.candidateSha256,
          decision: "accept",
          feedback: "",
        });
        replies.push(reply);
        void reply.catch(() => undefined);
      },
    });
    running = runtime.run();
    const result = await running;
    await Promise.all(replies);
    const records = await store.read(result.runId);
    return {
      result,
      requests,
      events,
      records,
      verifications,
      approvalCount: approve.mock.calls.length,
      fileContent: withWriteCall ? await readFile(target, "utf8") : undefined,
    };
  } finally {
    abort();
    await running?.catch(() => undefined);
    await Promise.allSettled(replies);
    let quiescent = false;
    try {
      quiescent = !runtime || (await runtime.waitForQuiescence());
      expect(quiescent).toBe(true);
    } finally {
      try {
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } finally {
        testSignal.removeEventListener("abort", abort);
        if (quiescent) {
          expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
          expect(path.basename(directory).startsWith("coremind-output-limit-")).toBe(true);
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  }
}
