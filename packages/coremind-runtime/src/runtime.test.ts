import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { fingerprintRunConfig, MemoryRunStore, RunStateJournal } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

describe("CoreMindRuntime", () => {
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

    await expect(runtime.run()).rejects.toMatchObject({ code: "agent_failed" });
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

    await expect(runtime.run()).rejects.toMatchObject({ code: "agent_failed" });
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

      await expect(runtime.run()).rejects.toMatchObject({ code: "budget_exceeded" });
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

      await expect(runtime.run()).rejects.toMatchObject({ code: "run_timeout" });
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
      const store = new MemoryRunStore();
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
      const runtime = await CoreMindRuntime.create({
        config,
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
      expect((await store.read("resume-run")).at(-1)?.kind).toBe("finish");
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
