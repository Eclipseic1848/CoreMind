import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { createDenyPolicyExtension, defineLifecycleExtension } from "./lifecycle-extension.js";
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
      finishReason: "agent_failed",
      error: { code: "agent_failed" },
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
      finishReason: "agent_failed",
      error: { code: "agent_failed" },
    });
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
      expect(
        result.trace
          .filter((entry) => entry.event.type === "effect_receipt")
          .map((entry) => entry.event.status),
      ).toEqual(["started", "committed"]);
    } finally {
      await closeServer(server);
    }
  });

  it("ask 模式全部工具请求被拒绝时返回暂停而不是成功", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-denied-"));
    writeFileSync(path.join(dir, "notes.txt"), "审批拒绝测试", "utf8");
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
        initialPrompt: "必须读取 notes.txt 才能完成任务",
        approveTool: async () => "deny",
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
    } finally {
      await closeServer(server);
    }
  });

  it("人工拒绝第一次工具审批后立即停止，不再次请求模型或审批", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-denied-stop-"));
    const target = path.join(dir, "article.md");
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

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          ...toolConfig(port, {
            runtime: { maxTurns: 3 },
            permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
          }),
          tools: [{ id: "write" }],
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "必须写入 article.md 才能完成任务",
        approveTool: async () => {
          approvals += 1;
          return "deny";
        },
      });

      const result = await runtime.run();

      expect(providerRequests).toBe(1);
      expect(approvals).toBe(1);
      expect(existsSync(target)).toBe(false);
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
      const store = new MemoryRunStore();
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-loop-resume-"));
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
          if (event.type === "step_start" && event.stepId === "loop-execute") {
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
