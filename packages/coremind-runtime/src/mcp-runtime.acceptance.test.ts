import "../../../test/setup-env.js";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, type TestContext, vi } from "vitest";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import type { CoreMindEvent } from "./events.js";
import {
  FileRunStore,
  fingerprintRunConfig,
  prepareRunResume,
  type RunStateRecord,
} from "./run-state.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";
import { TOOL_CALL_PHASES } from "./tool-call-lifecycle.js";
import type { ToolApprovalRequest } from "./tool-policy.js";
import { redactSensitiveText } from "./trace.js";

const service = fileURLToPath(
  new URL("../../../test/fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const serviceSecret = "mcp-runtime-private-763902";
const businessArgs = { value: { flag: false, count: 0, empty: null } };
const inputSchema = {
  type: "object",
  $defs: { value: {} },
  properties: { value: { $ref: "#/$defs/value" } },
  required: ["value"],
  additionalProperties: false,
};

type WireRequest = {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ type: string; function: { name: string; parameters: unknown } }>;
};
type FixtureRecord = Record<string, unknown> & { type?: string; method?: string };

describe("本地 MCP 真实 Runtime 准入", () => {
  it("connect/list/call 均在真实 critical barrier 后执行，首个模型使用冻结目录与真实批准目标", async (context) => {
    await withProject(context, async (project) => {
      const startupTrace = Reflect.get(globalThis, Symbol.for("coremind.mcpStartup.capture"))?.();
      const gates = Array.from({ length: 3 }, () => ({
        entered: deferred<void>(),
        release: deferred<void>(),
      }));
      project.onCancel(() => {
        for (const gate of gates) gate.release.resolve();
      });
      let stage = 0;
      const store = new FileRunStore(path.join(project.directory, "runs"), {
        beforeBarrier: async ({ record }) => {
          const event =
            record?.kind === "event"
              ? (record.payload as { event: CoreMindEvent }).event
              : undefined;
          if (event?.type !== "effect_receipt" || event.status !== "started") return;
          const gate = gates[stage++];
          if (!gate) throw new Error("夹具收到了额外的 started 屏障");
          if (stage === 2) startupTrace?.("list_gate_enter");
          gate.entered.resolve();
          await gate.release.promise;
        },
      });
      const approvals: ToolApprovalRequest[] = [];
      const observed: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config: project.config,
        configDir: project.directory,
        cwd: project.directory,
        runStore: store,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "通过已授权本地工具完成回声",
        approveTool: async (request) => {
          approvals.push(request);
          return "allow";
        },
        events: (event) => {
          observed.push(event);
          if (event.type === "tool_lifecycle" && event.resolution.phase === "executing")
            startupTrace?.("runtime_executing");
          if (event.type === "tool_lifecycle" && event.resolution.phase === "observed")
            startupTrace?.("observed");
        },
      });
      expect(existsSync(project.recordFile)).toBe(false);
      expect(project.requests).toEqual([]);
      project.running = runtime.run();
      try {
        await waitForBarrier("connect", gates[0]!.entered.promise, project.running, observed);
        expect(existsSync(project.recordFile)).toBe(false);
        expect(project.requests).toHaveLength(0);
        startupTrace?.("connect_gate_release");
        gates[0]!.release.resolve();

        await waitForBarrier("list", gates[1]!.entered.promise, project.running, observed);
        let records = await serviceRecords(project.recordFile);
        expect(records.filter((record) => record.type === "started")).toHaveLength(1);
        expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
        expect(records.filter((record) => record.method === "tools/list")).toHaveLength(0);
        expect(project.requests).toHaveLength(0);
        gates[1]!.release.resolve();

        await waitForBarrier("business", gates[2]!.entered.promise, project.running, observed);
        records = await serviceRecords(project.recordFile);
        expect(records.filter((record) => record.method === "tools/list")).toHaveLength(2);
        expect(records.filter((record) => record.method === "tools/call")).toHaveLength(0);
        expect(project.requests).toHaveLength(1);
        const started = processRecord(records);
        expect(alive(started.pid)).toBe(true);
        expect(alive(started.childPid)).toBe(true);
        gates[2]!.release.resolve();

        const result = await bounded(project.running, "Run 完成");
        expect(result.outcome.status, runSummary(result, observed)).toBe("succeeded");
        expect(stage).toBe(3);
        expect(project.requests).toHaveLength(2);
        const declared = project.requests[0]!.tools!;
        expect(declared).toHaveLength(1);
        const name = declared[0]!.function.name;
        expect(name).toMatch(/^mcp_[A-Za-z0-9_-]+$/u);
        expect(declared[0]!.function.parameters).toEqual(inputSchema);
        expect(approvals).toHaveLength(3);
        const business = approvals.find((request) => request.tool === name)!;
        const envelope = business.args as { mcp: Record<string, unknown>; arguments: unknown };
        expect(envelope.arguments).toEqual(businessArgs);
        expect(envelope.mcp).toMatchObject({
          server: "local",
          command: await realpath(process.execPath),
          cwd: await realpath(project.directory),
          argv: [service, project.recordFile],
          tool: "echo",
          schemaSha256: fingerprintEffectReceiptValue({ inputSchema }),
          effect: { operations: ["external"], reversible: false },
          capability: {
            effect: "external",
            replay: "unknown",
            concurrency: "run_serial",
            checkpoint: "unsupported",
            durability: "critical",
          },
        });
        expect(envelope.mcp.serverIdentity).toMatch(/^[0-9a-f]{64}$/u);
        expect(business.argumentsFingerprint).toBe(fingerprintEffectReceiptValue(envelope));
        const persisted = await store.read(result.runId);
        const events = traceEvents(persisted);
        const publicApprovals = events.filter((event) => event.type === "approval_required");
        expect(publicApprovals).toHaveLength(3);
        expect(publicApprovals.find((event) => event.tool === name)).toMatchObject({
          args: {
            ...envelope,
            mcp: { ...envelope.mcp, envReferences: { MCP_TEST_SECRET: "<已隐藏>" } },
          },
          argumentsFingerprint: business.argumentsFingerprint,
        });
        const calls = events.filter((event) => event.type === "tool_call");
        expect(calls).toHaveLength(3);
        expect(calls.map((event) => event.tool)).toEqual([
          approvals[0]!.tool,
          approvals[1]!.tool,
          name,
        ]);
        expect(new Set(calls.map((event) => event.callId)).size).toBe(3);
        expect(new Set(calls.map((event) => event.turnId)).size).toBe(3);
        for (const call of calls) {
          expect(call.argumentsFingerprint).toMatch(/^[0-9a-f]{64}$/u);
          const phases = events.filter(
            (event): event is Extract<CoreMindEvent, { type: "tool_lifecycle" }> =>
              event.type === "tool_lifecycle" && event.callId === call.callId,
          );
          expect(phases.map((event) => event.resolution.phase)).toEqual(TOOL_CALL_PHASES);
          const effects = events.filter(
            (event): event is Extract<CoreMindEvent, { type: "effect_receipt" }> =>
              event.type === "effect_receipt" && event.callId === call.callId,
          );
          expect(effects.map((event) => event.status)).toEqual(["started", "committed"]);
          for (const receipt of effects)
            expect(receipt.binding).toMatchObject({
              runId: result.runId,
              turnId: call.turnId,
              tool: call.tool,
              argumentsFingerprint: call.argumentsFingerprint,
            });
          expect(
            events
              .filter(
                (event): event is Extract<CoreMindEvent, { type: "workspace_lease" }> =>
                  event.type === "workspace_lease" && event.callId === call.callId,
              )
              .map((event) => event.status),
          ).toEqual(["acquired", "released"]);
        }
        expect(
          project.requests[0]!.messages.some(
            (message) => message.role === "assistant" || message.role === "tool",
          ),
        ).toBe(false);
        expect(events.some((event) => event.type === "quiescence_timeout")).toBe(false);
        const completedRecords = await serviceRecords(project.recordFile);
        expect(completedRecords).toContainEqual({
          type: "environment",
          allowed: true,
          forbidden: false,
        });
        const wireCalls = completedRecords.filter((record) => record.method === "tools/call");
        expect(wireCalls).toHaveLength(1);
        expect(wireCalls[0]!.params).toMatchObject({ name: "echo", arguments: businessArgs });
        expect((wireCalls[0]!.params as Record<string, unknown>).arguments).not.toHaveProperty(
          "mcp",
        );
        expect(JSON.stringify({ persisted, requests: project.requests, approvals })).not.toContain(
          serviceSecret,
        );
        await vi.waitFor(
          () => {
            expect(alive(started.pid)).toBe(false);
            expect(alive(started.childPid)).toBe(false);
          },
          { timeout: 3_000, interval: 20 },
        );
      } finally {
        for (const gate of gates) gate.release.resolve();
      }
    });
  }, 60_000);

  it.for(["list", "call"] as const)("拒绝 %s 审批时对应真实请求为零", async (target, context) => {
    await withProject(context, async (project) => {
      const approvals: ToolApprovalRequest[] = [];
      const rejectedIndex = target === "list" ? 2 : 3;
      const runtime = await CoreMindRuntime.create({
        config: project.config,
        configDir: project.directory,
        cwd: project.directory,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "审批拒绝必须阻止真实发送",
        approveTool: async (request) => {
          approvals.push(request);
          return approvals.length === rejectedIndex ? "deny" : "allow";
        },
      });
      project.running = runtime.run();
      const result = await bounded(project.running, "Run 完成");
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
      expect(approvals).toHaveLength(rejectedIndex);
      const records = await serviceRecords(project.recordFile);
      expect(records.filter((record) => record.type === "started")).toHaveLength(1);
      expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
      expect(records.filter((record) => record.method === "tools/list")).toHaveLength(
        target === "list" ? 0 : 2,
      );
      expect(records.filter((record) => record.method === "tools/call")).toHaveLength(0);
      expect(project.requests).toHaveLength(target === "list" ? 0 : 1);
      const rejectedTool = approvals.at(-1)!.tool;
      expect(result.trace).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({ type: "policy_denied", tool: rejectedTool }),
        }),
      );
      expect(result.trace).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "effect_receipt",
            tool: rejectedTool,
            status: "not_started",
          }),
        }),
      );
      expect(result.trace.some(({ event }) => event.type === "quiescence_timeout")).toBe(false);
    });
  });

  it("connect 与 list 已耗尽两次工具预算，业务调用在批准和发送前阻断", async (context) => {
    await withProject(context, async (project) => {
      const approvals: ToolApprovalRequest[] = [];
      const runtime = await CoreMindRuntime.create({
        config: { ...project.config, runtime: { ...project.config.runtime, maxToolCalls: 2 } },
        configDir: project.directory,
        cwd: project.directory,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "只有两次工具预算",
        approveTool: async (request) => {
          approvals.push(request);
          return "allow";
        },
      });
      project.running = runtime.run();
      const result = await bounded(project.running, "Run 完成");
      expect(result.outcome).toMatchObject({
        status: "budget_exceeded",
        error: { code: "budget_exceeded" },
      });
      expect(approvals).toHaveLength(2);
      expect(approvals.map((request) => request.capability?.effect)).toEqual([
        "process",
        "external",
      ]);
      const records = await serviceRecords(project.recordFile);
      expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
      expect(records.filter((record) => record.method === "tools/list")).toHaveLength(2);
      expect(records.filter((record) => record.method === "tools/call")).toHaveLength(0);
      expect(project.requests).toHaveLength(1);
      expect(result.trace).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "budget_exceeded",
            dimension: "toolCalls",
            limit: 2,
            actual: 3,
          }),
        }),
      );
      const calls = result.trace.filter(({ event }) => event.type === "tool_call");
      expect(calls).toHaveLength(3);
      expect(result.trace.some(({ event }) => event.type === "quiescence_timeout")).toBe(false);
    });
  });

  it.for(["connect", "list"] as const)(
    "%s started 关键提交失败阻止真实 I/O",
    async (target, context) => {
      await withProject(context, async (project) => {
        let failures = 0;
        const store = new FileRunStore(path.join(project.directory, "runs"), {
          beforeBarrier: ({ record }) => {
            const event =
              record?.kind === "event"
                ? (record.payload as { event: CoreMindEvent }).event
                : undefined;
            if (
              event?.type === "effect_receipt" &&
              event.status === "started" &&
              event.tool.startsWith(`mcp_${target}_`)
            ) {
              failures++;
              throw new Error(`${target} 的 started 受控持久化失败`);
            }
          },
        });
        const runtime = await CoreMindRuntime.create({
          config: project.config,
          configDir: project.directory,
          cwd: project.directory,
          runStore: store,
          env: project.env,
          signal: project.controller.signal,
          initialPrompt: "持久确认前不得执行",
          approveTool: async () => "allow",
        });
        project.running = runtime.run();
        const result = await bounded(project.running, "Run 完成");
        expect(failures).toBe(1);
        expect(result.outcome).toMatchObject({
          status: "failed",
          error: { code: "durability_barrier_failed" },
        });
        const records = await serviceRecords(project.recordFile);
        expect(records.filter((record) => record.type === "started")).toHaveLength(
          target === "connect" ? 0 : 1,
        );
        expect(records.filter((record) => record.method === "initialize")).toHaveLength(
          target === "connect" ? 0 : 1,
        );
        expect(records.filter((record) => record.method === "tools/list")).toHaveLength(0);
        expect(records.filter((record) => record.method === "tools/call")).toHaveLength(0);
        expect(project.requests).toHaveLength(0);
      });
    },
  );

  it("connect 结果持久化未确认前不准入 list，释放后完成真实调用", async (context) => {
    await withProject(context, async (project) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      project.onCancel(() => release.resolve());
      const observed: CoreMindEvent[] = [];
      const approvals: ToolApprovalRequest[] = [];
      let barriers = 0;
      const store = new FileRunStore(path.join(project.directory, "runs"), {
        beforeBarrier: async ({ record }) => {
          const event =
            record?.kind === "event"
              ? (record.payload as { event: CoreMindEvent }).event
              : undefined;
          if (event?.type === "tool_result" && event.tool.startsWith("mcp_connect_")) {
            barriers++;
            entered.resolve();
            await release.promise;
          }
        },
      });
      const runtime = await CoreMindRuntime.create({
        config: project.config,
        configDir: project.directory,
        cwd: project.directory,
        runStore: store,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "确认连接结果后才能读取目录",
        approveTool: async (request) => {
          approvals.push(request);
          return "allow";
        },
        events: (event) => observed.push(event),
      });
      project.running = runtime.run();
      try {
        await waitForBarrier("connect-result", entered.promise, project.running, observed);
        const records = await serviceRecords(project.recordFile);
        expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
        expect(records.filter((record) => record.method === "tools/list")).toHaveLength(0);
        expect(project.requests).toHaveLength(0);
        expect(approvals).toHaveLength(1);
        expect(
          observed.some(
            (event) => event.type === "tool_call" && event.tool.startsWith("mcp_list_"),
          ),
        ).toBe(false);
        release.resolve();
        const result = await bounded(project.running, "connect-result 释放后 Run 完成");
        expect(result.outcome.status, runSummary(result, observed)).toBe("succeeded");
        expect(barriers).toBe(1);
        expect(approvals).toHaveLength(3);
        const completed = await serviceRecords(project.recordFile);
        expect(completed.filter((record) => record.method === "tools/list")).toHaveLength(2);
        expect(completed.filter((record) => record.method === "tools/call")).toHaveLength(1);
        expect(project.requests).toHaveLength(2);
      } finally {
        release.resolve();
      }
    });
  }, 60_000);

  it.for(["workflow", "loop"] as const)(
    "%s 选中 MCP 后首个模型使用冻结 schema 并完成真实调用",
    { timeout: 60_000 },
    async (mode, context) => {
      await withProject(context, async (project) => {
        const approvals: ToolApprovalRequest[] = [];
        const runtime = await CoreMindRuntime.create({
          config: orchestratedConfig(project.config, mode),
          configDir: project.directory,
          cwd: project.directory,
          env: project.env,
          signal: project.controller.signal,
          initialPrompt: "执行本地工具",
          approveTool: async (request) => {
            approvals.push(request);
            return "allow";
          },
        });
        project.running = runtime.run();
        const result = await bounded(project.running, "Run 完成");
        expect(result.outcome.status, runSummary(result, [])).toBe("succeeded");
        expect(project.requests).toHaveLength(mode === "workflow" ? 2 : 3);
        expect(project.requests[0]!.tools).toHaveLength(1);
        const declared = project.requests[0]!.tools![0]!.function;
        expect(declared.name).toMatch(/^mcp_[A-Za-z0-9_-]+$/u);
        expect(declared.parameters).toEqual(inputSchema);
        expect(approvals).toHaveLength(3);
        expect(approvals[2]!.tool).toBe(declared.name);
        const records = await serviceRecords(project.recordFile);
        expect(records.filter((record) => record.type === "started")).toHaveLength(1);
        expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
        expect(records.filter((record) => record.method === "tools/list")).toHaveLength(2);
        expect(records.filter((record) => record.method === "tools/call")).toEqual([
          expect.objectContaining({ params: { name: "echo", arguments: businessArgs } }),
        ]);
        expect(result.outputs.get(mode === "workflow" ? "mcp-output" : "candidate")?.text).toBe(
          "本地工具验收完成",
        );
        if (mode === "loop") {
          expect(
            project.requests[2]!.tools?.some((tool) => tool.function.name.startsWith("mcp_")) ??
              false,
          ).toBe(false);
          expect(result.trace).toContainEqual(
            expect.objectContaining({
              event: expect.objectContaining({ type: "loop_state", to: "succeeded" }),
            }),
          );
        } else {
          expect(result.trace).toContainEqual(
            expect.objectContaining({
              event: expect.objectContaining({ type: "step_end", stepId: "mcp-step", ok: true }),
            }),
          );
        }
        expect(result.trace.some(({ event }) => event.type === "quiescence_timeout")).toBe(false);
      });
    },
  );

  it.for(["workflow", "loop"] as const)(
    "%s 的 step_timeout 包含 MCP 连接审批准备且阻止迟到启动",
    { timeout: 60_000 },
    async (mode, context) => {
      await withProject(context, async (project) => {
        const entered = deferred<void>();
        const release = deferred<void>();
        project.onCancel(() => release.resolve());
        const observed: CoreMindEvent[] = [];
        const approvals: ToolApprovalRequest[] = [];
        const stepTimeoutMs = 60_137;
        const runtime = await CoreMindRuntime.create({
          config: orchestratedConfig(project.config, mode),
          configDir: project.directory,
          cwd: project.directory,
          env: project.env,
          signal: project.controller.signal,
          initialPrompt: "准备阶段必须计入步骤期限",
          stepTimeoutMs,
          approveTool: async (request) => {
            approvals.push(request);
            entered.resolve();
            await release.promise;
            return "allow";
          },
          events: (event) => observed.push(event),
        });
        const callbacks: Array<() => void> = [];
        const handles: Array<ReturnType<typeof setTimeout>> = [];
        const realSetTimeout = globalThis.setTimeout;
        // 只捕获本用例独有的步骤定时器；审批已进入后触发原回调，其他计时器保持真实。
        const timer = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((callback, delay, ...args) => {
            if (delay !== stepTimeoutMs) return realSetTimeout(callback, delay, ...args);
            callbacks.push(() => callback(...args));
            const handle = realSetTimeout(() => {}, delay);
            handles.push(handle);
            return handle;
          });
        try {
          project.running = runtime.run();
          await waitForBarrier("connect-approval", entered.promise, project.running, observed);
          expect(approvals).toHaveLength(1);
          expect(approvals[0]!.tool).toMatch(/^mcp_connect_/u);
          expect(callbacks).toHaveLength(1);
          expect(existsSync(project.recordFile)).toBe(false);
          expect(project.requests).toHaveLength(0);
          callbacks[0]!();
          release.resolve();
          const result = await bounded(project.running, "Run 完成");
          expect(result.outcome, runSummary(result, observed)).toMatchObject({
            status: "timeout",
            finishReason: "step_timeout",
            error: { code: "step_timeout" },
          });
          expect(await runtime.waitForQuiescence()).toBe(true);
          expect(approvals).toHaveLength(1);
          expect(existsSync(project.recordFile)).toBe(false);
          expect(project.requests).toHaveLength(0);
          expect(result.trace.some(({ event }) => event.type === "quiescence_timeout")).toBe(false);
        } finally {
          release.resolve();
          project.controller.abort();
          for (const handle of handles) clearTimeout(handle);
          timer.mockRestore();
        }
      });
    },
  );

  it.for([
    ["默认权限", undefined, undefined],
    ["工作区约束", { mode: "full", workspaceOnly: true, network: "allow" }, "allow"],
    ["断网约束", { mode: "full", workspaceOnly: false, network: "deny" }, "allow"],
    ["按需网络约束", { mode: "full", workspaceOnly: false, network: "ask" }, "allow"],
    ["连接审批拒绝", { mode: "ask", workspaceOnly: false, network: "allow" }, "deny"],
    ["缺少审批处理器", { mode: "ask", workspaceOnly: false, network: "allow" }, undefined],
  ] as const)("%s 在服务启动与模型请求前阻断", async ([_name, permissions, decision], context) => {
    await withProject(context, async (project) => {
      const config = { ...project.config, permissions };
      const approvals: ToolApprovalRequest[] = [];
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: project.directory,
        cwd: project.directory,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "不得启动未获准的程序",
        ...(decision
          ? {
              approveTool: async (request: ToolApprovalRequest) => {
                approvals.push(request);
                return decision;
              },
            }
          : {}),
      });
      project.running = runtime.run();
      const result = await bounded(project.running, "Run 完成");
      expect(result.outcome.status).not.toBe("succeeded");
      expect(existsSync(project.recordFile)).toBe(false);
      expect(project.requests).toHaveLength(0);
      expect(result.trace.some(({ event }) => event.type === "policy_denied")).toBe(true);
      expect(approvals).toHaveLength(decision === "deny" ? 1 : 0);
    });
  });

  it.for([false, true])(
    "未选 MCP 的 Agent 不加载其他目录（声明服务=%s）",
    async (configured, context) => {
      await withProject(context, async (project) => {
        const config: CoreMindConfig = configured
          ? {
              ...project.config,
              agents: { main: { tools: [{ id: "read" }] }, other: project.config.agents.main! },
              tools: [],
            }
          : { ...project.config, mcp: undefined, tools: [], agents: { main: {} } };
        const runtime = await CoreMindRuntime.create({
          config,
          configDir: project.directory,
          cwd: project.directory,
          env: project.env,
          signal: project.controller.signal,
          initialPrompt: "直接完成，不使用工具",
        });
        project.running = runtime.run();
        const result = await bounded(project.running, "Run 完成");
        expect(result.outcome.status).toBe("succeeded");
        expect(project.requests).toHaveLength(1);
        expect(existsSync(project.recordFile)).toBe(false);
        expect(
          project.requests[0]!.tools?.some((tool) => tool.function.name.startsWith("mcp_")) ??
            false,
        ).toBe(false);
        expect(result.trace.filter(({ event }) => event.type === "tool_call")).toEqual([]);
      });
    },
  );

  it("未授权 Agent 猜中另一 Agent 的真实 MCP 别名也不能执行", async (context) => {
    await withProject(context, async (project) => {
      const config: CoreMindConfig = {
        ...project.config,
        defaultAgent: "main",
        agents: { ...project.config.agents, plain: { tools: [{ id: "read" }] } },
      };
      const authorized = await CoreMindRuntime.create({
        config,
        configDir: project.directory,
        cwd: project.directory,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "先取得真实已授权工具",
        approveTool: async () => "allow",
      });
      project.running = authorized.run();
      expect((await bounded(project.running, "Run 完成")).outcome.status).toBe("succeeded");
      const knownAlias = project.requests[0]!.tools![0]!.function.name;
      expect(knownAlias).toMatch(/^mcp_[A-Za-z0-9_-]+$/u);
      const recordsBefore = await serviceRecords(project.recordFile);
      const owned = processRecord(recordsBefore);
      await vi.waitFor(() => {
        expect(alive(owned.pid)).toBe(false);
        expect(alive(owned.childPid)).toBe(false);
      });
      const callsBefore = recordsBefore.filter(
        (record) =>
          record.type === "started" || record.type === "request" || record.type === "effect",
      );
      expect(callsBefore.filter((record) => record.method === "tools/call")).toHaveLength(1);
      const requestOffset = project.requests.length;
      const approvals: ToolApprovalRequest[] = [];
      // 让真实模型响应猜中已存在的别名，不向未授权 Agent 的工具目录注入任何声明。
      project.nextToolCall = knownAlias;
      const unauthorized = await CoreMindRuntime.create({
        config: { ...config, defaultAgent: "plain" },
        configDir: project.directory,
        cwd: project.directory,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "尝试猜中的工具名",
        approveTool: async (request) => {
          approvals.push(request);
          return "allow";
        },
      });
      project.running = unauthorized.run();
      const result = await bounded(project.running, "Run 完成");
      const requests = project.requests.slice(requestOffset);
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) => !request.tools?.some((tool) => tool.function.name === knownAlias),
        ),
      ).toBe(true);
      expect(result.trace).toContainEqual(
        expect.objectContaining({
          event: expect.objectContaining({
            type: "tool_result",
            agent: "plain",
            tool: knownAlias,
            isError: true,
          }),
        }),
      );
      expect(approvals).toEqual([]);
      expect(
        (await serviceRecords(project.recordFile)).filter(
          (record) =>
            record.type === "started" || record.type === "request" || record.type === "effect",
        ),
      ).toEqual(callsBefore);
      expect(result.trace.some(({ event }) => event.type === "quiescence_timeout")).toBe(false);
    });
  }, 60_000);

  it("业务已发生效果后取消记录 unknown，关闭真实树且冷恢复不重放", async (context) => {
    await withProject(context, async (project) => {
      const selection = project.config.agents.main!.tools![0]!;
      if (!("mcp" in selection)) throw new Error("夹具缺少选中的 MCP 工具");
      const server = project.config.mcp!.servers.local!;
      if (server.transport !== "stdio") throw new Error("夹具缺少本地 stdio 服务");
      const config: CoreMindConfig = {
        ...project.config,
        mcp: { servers: { local: { ...server, args: [...server.args, "effect-then-hang"] } } },
        agents: {
          main: { tools: [{ ...selection, mcp: { ...selection.mcp, tool: "write_once" } }] },
        },
      };
      const store = new FileRunStore(path.join(project.directory, "runs-cancel"));
      const observed: CoreMindEvent[] = [];
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: project.directory,
        cwd: project.directory,
        runStore: store,
        env: project.env,
        signal: project.controller.signal,
        initialPrompt: "只执行一次真实效果后取消",
        approveTool: async () => "allow",
        events: (event) => observed.push(event),
      });
      project.running = runtime.run();
      await waitForBarrier(
        "business",
        vi.waitFor(
          async () => {
            expect(
              (await serviceRecords(project.recordFile)).filter(
                (record) => record.type === "effect",
              ),
            ).toHaveLength(1);
          },
          { timeout: 10_000, interval: 20 },
        ),
        project.running,
        observed,
      );
      const started = processRecord(await serviceRecords(project.recordFile));
      expect(alive(started.pid)).toBe(true);
      expect(alive(started.childPid)).toBe(true);
      const alias = project.requests[0]!.tools![0]!.function.name;
      const call = observed.find(
        (event): event is Extract<CoreMindEvent, { type: "tool_call" }> =>
          event.type === "tool_call" && event.tool === alias,
      );
      expect(call?.callId).toBeTypeOf("string");
      expect(observed).toContainEqual(
        expect.objectContaining({
          type: "effect_receipt",
          tool: alias,
          callId: call!.callId,
          status: "started",
        }),
      );
      project.controller.abort();
      const result = await bounded(project.running, "Run 完成");
      expect(result.outcome).toMatchObject({ status: "aborted", finishReason: "aborted" });
      expect(await runtime.waitForQuiescence()).toBe(true);
      const persisted = await store.read(result.runId);
      const events = traceEvents(persisted);
      expect(
        events
          .filter(
            (event): event is Extract<CoreMindEvent, { type: "effect_receipt" }> =>
              event.type === "effect_receipt" && event.callId === call!.callId,
          )
          .map((event) => event.status),
      ).toEqual(["started", "unknown"]);
      const records = await serviceRecords(project.recordFile);
      expect(records.filter((record) => record.method === "tools/call")).toEqual([
        expect.objectContaining({ params: { name: "write_once", arguments: businessArgs } }),
      ]);
      expect(records.filter((record) => record.type === "effect")).toHaveLength(1);
      expect(project.requests).toHaveLength(1);
      await vi.waitFor(() => {
        expect(alive(started.pid)).toBe(false);
        expect(alive(started.childPid)).toBe(false);
      });
      const unknownIndex = persisted.findIndex((record) => {
        const event =
          record.kind === "event" ? (record.payload as { event: CoreMindEvent }).event : undefined;
        return (
          event?.type === "effect_receipt" &&
          event.callId === call!.callId &&
          event.status === "unknown"
        );
      });
      expect(unknownIndex).toBeGreaterThan(0);
      // 使用真实持久序列在 unknown 后的连续崩溃前缀，不修改原 Store 或伪造恢复事实。
      const prefix = persisted.slice(0, unknownIndex + 1);
      // connect 已提交的非安全效果先被原恢复门发现，不能为 MCP 伪造更宽松的恢复原因。
      expect(() => prepareRunResume(prefix, fingerprintRunConfig(config))).toThrowError(
        expect.objectContaining({ code: "committed_effect_pending" }),
      );
      expect(await store.read(result.runId)).toEqual(persisted);
      expect(
        (await serviceRecords(project.recordFile)).filter(
          (record) =>
            record.type === "started" || record.type === "request" || record.type === "effect",
        ),
      ).toEqual(
        records.filter(
          (record) =>
            record.type === "started" || record.type === "request" || record.type === "effect",
        ),
      );
      expect(project.requests).toHaveLength(1);
      expect(events.some((event) => event.type === "quiescence_timeout")).toBe(false);
    });
  }, 60_000);
  it("测试取消先放行夹具等待并 join 动作，再关闭并删除目录", async (context) => {
    const controller = new AbortController();
    const release = deferred<void>();
    let directory = "";
    let actionFinished = false;
    await withProject(
      { signal: controller.signal, onTestFinished: context.onTestFinished },
      async (project) => {
        directory = project.directory;
        project.onCancel(() => release.resolve());
        queueMicrotask(() => controller.abort());
        await release.promise;
        await writeFile(path.join(directory, "owned-cleanup.txt"), "已完成自有动作收尾", "utf8");
        actionFinished = true;
      },
    );
    expect(actionFinished).toBe(true);
    expect(existsSync(directory)).toBe(false);
  });
});

interface Project {
  directory: string;
  recordFile: string;
  requests: WireRequest[];
  config: CoreMindConfig;
  env: NodeJS.ProcessEnv;
  controller: AbortController;
  onCancel(release: () => void): void;
  running?: Promise<RunResult>;
  nextToolCall?: string;
}

function orchestratedConfig(config: CoreMindConfig, mode: "workflow" | "loop"): CoreMindConfig {
  if (mode === "workflow")
    return {
      ...config,
      workflow: [
        {
          id: "mcp-step",
          type: "prompt",
          agent: "main",
          input: "执行 {{prompt}}",
          saveAs: "mcp-output",
        },
      ],
    };
  return {
    ...config,
    agents: { ...config.agents, reviewer: { tools: [{ id: "read" }] } },
    loop: {
      execute: { agent: "main", input: "执行 {{prompt}}" },
      verify: {
        agent: "reviewer",
        input: "验证 {{candidate.text}}",
        passIf: "{{text}} == 本地工具验收完成",
      },
      repair: { agent: "main", input: "修复 {{candidate.text}}" },
      maxIterations: 1,
      maxRepairs: 0,
      onFailure: "fail",
      onExhausted: "fail",
    },
  };
}

async function withProject(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  action: (project: Project) => Promise<void>,
) {
  const startupTrace = Reflect.get(globalThis, Symbol.for("coremind.mcpStartup.capture"))?.();
  startupTrace?.("fixture_enter");
  const controller = new AbortController();
  const releases = new Set<() => void>();
  const requests: WireRequest[] = [];
  const errors: unknown[] = [];
  const failures: unknown[] = [];
  let directory = "";
  let recordFile = "";
  let project: Project | undefined;
  let body: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as WireRequest;
        requests.push(parsed);
        const tool = parsed.tools?.find((entry) => entry.function.name.startsWith("mcp_"));
        const toolName =
          project!.nextToolCall ?? (requests.length === 1 ? tool?.function.name : undefined);
        delete project!.nextToolCall;
        const call = toolName !== undefined;
        const delta = call
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "mcp-business-call",
                  type: "function",
                  function: { name: toolName, arguments: JSON.stringify(businessArgs) },
                },
              ],
            }
          : { role: "assistant", content: "本地工具验收完成" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [
          { id: `mcp-${requests.length}`, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id: `mcp-${requests.length}`,
            choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }],
          },
        ])
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) {
        errors.push(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "本地模型夹具失败" } }));
      }
    });
  });
  const cancel = () => {
    startupTrace?.("fixture_abort");
    controller.abort();
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
  };
  const close = () =>
    (closing ??= (async () => {
      cancel();
      // body 不包含 close，先 join 完整创建/动作，避免迟到 Run 越过清理快照。
      await body;
      releases.clear();
      if (project?.running) {
        try {
          await project.running;
        } catch (error) {
          failures.push(error);
        } finally {
          startupTrace?.("run_settled");
        }
      }
      let processesStopped = true;
      try {
        const started = recordFile
          ? (await serviceRecords(recordFile)).find((record) => record.type === "started")
          : undefined;
        if (started) {
          for (const pid of [
            (started as { childPid: number }).childPid,
            (started as { pid: number }).pid,
          ]) {
            if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
              throw new Error("夹具自有 PID 无效");
            if (!alive(pid)) continue;
            failures.push(new Error("Runtime 完成后夹具自有进程仍在运行"));
            if (process.platform === "win32") {
              const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
                windowsHide: true,
                timeout: 2_000,
              });
              if (result.error) failures.push(result.error);
              if (result.status !== 0 && alive(pid))
                failures.push(new Error("夹具自有进程终止失败"));
            } else process.kill(pid, "SIGKILL");
            await vi.waitFor(() => expect(alive(pid)).toBe(false), {
              timeout: 2_000,
              interval: 20,
            });
          }
        }
      } catch (error) {
        processesStopped = false;
        failures.push(error);
      }
      try {
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        if (directory && processesStopped) {
          expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
          expect(path.basename(directory).startsWith("coremind-mcp-acceptance-")).toBe(true);
          await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
        } else if (directory) failures.push(new Error("自有进程未确认退出，保留夹具目录"));
      } catch (error) {
        failures.push(error);
      }
      context.signal.removeEventListener("abort", cancel);
      startupTrace?.("cleanup_done");
      failures.push(...errors);
      if (failures.length) throw new AggregateError(failures, "MCP 真实 Runtime 主流程与资源清理");
    })());
  context.signal.addEventListener("abort", cancel, { once: true });
  context.onTestFinished(close);
  if (context.signal.aborted) cancel();
  body = (async () => {
    try {
      directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-acceptance-"));
      recordFile = path.join(directory, "service.jsonl");
      controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.once("error", failed);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", failed);
          resolve();
        });
      });
      controller.signal.throwIfAborted();
      project = {
        directory,
        recordFile,
        requests,
        controller,
        onCancel: (release) => {
          releases.add(release);
          if (controller.signal.aborted) release();
        },
        env: { ...process.env, MCP_TEST_SECRET: serviceSecret, COREMIND_MCP_UNLISTED: "host-only" },
        config: {
          schemaVersion: 2,
          name: "MCP 真实验收",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          mcp: {
            servers: {
              local: {
                transport: "stdio",
                command: process.execPath,
                args: [service, recordFile],
                cwd: directory,
                env: { MCP_TEST_SECRET: { env: "MCP_TEST_SECRET" } },
              },
            },
          },
          agents: {
            main: {
              tools: [
                {
                  mcp: { server: "local", tool: "echo" },
                  effect: { operations: ["external"], reversible: false },
                  capability: {
                    effect: "external",
                    replay: "unknown",
                    concurrency: "run_serial",
                    checkpoint: "unsupported",
                    durability: "critical",
                  },
                },
              ],
            },
          },
          permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
          runtime: { maxTurns: 3, maxRetries: 0, maxToolCalls: 3, runTimeoutMs: 0 },
        },
      };
      const activeProject = project;
      startupTrace?.("fixture_ready");
      await (startupTrace ? startupTrace.run(() => action(activeProject)) : action(activeProject));
    } catch (error) {
      failures.push(error);
    }
  })();
  try {
    await body;
  } finally {
    await close();
  }
}

function traceEvents(records: RunStateRecord[]): CoreMindEvent[] {
  return records.flatMap((record) =>
    record.kind === "event" ? [(record.payload as { event: CoreMindEvent }).event] : [],
  );
}

async function serviceRecords(file: string): Promise<FixtureRecord[]> {
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function processRecord(records: FixtureRecord[]): { pid: number; childPid: number } {
  const record = records.find((entry) => entry.type === "started");
  if (!record || !Number.isInteger(record.pid) || !Number.isInteger(record.childPid))
    throw new Error("缺少真实服务与子进程 PID");
  return record as { pid: number; childPid: number };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function waitForBarrier(
  label: "connect" | "list" | "business" | "connect-result" | "connect-approval",
  entered: Promise<void>,
  running: Promise<RunResult>,
  observed: CoreMindEvent[],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      running.then(
        (result) => {
          throw new Error(`${label} started 屏障前 Run 已结束：${runSummary(result, observed)}`);
        },
        (error: unknown) => {
          throw new Error(
            `${label} started 屏障前 Run 抛错：${safeMessage(error)}；${runSummary(undefined, observed)}`,
          );
        },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          Reflect.get(globalThis, Symbol.for("coremind.mcpStartup.capture"))?.()?.(
            `wait_${label.replaceAll("-", "_")}_timeout`,
          );
          reject(new Error(`${label} started 屏障等待超时：${runSummary(undefined, observed)}`));
        }, 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runSummary(result: RunResult | undefined, observed: CoreMindEvent[]): string {
  const error = result && "error" in result.outcome ? result.outcome.error : undefined;
  return JSON.stringify({
    status: result?.outcome.status ?? "pending",
    ...(error ? { error: { code: error.code, message: safeMessage(error) } } : {}),
    events: observed.slice(-20).map((event) => event.type),
    phases: observed
      .filter((event) => event.type === "tool_lifecycle")
      .slice(-12)
      .map((event) => ({
        tool: event.tool,
        phase: event.resolution.phase,
        status: event.resolution.status,
      })),
    errors: observed
      .filter((event) => event.type === "error")
      .slice(-2)
      .map((event) => safeMessage(event.message)),
  });
}

function safeMessage(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : value &&
            typeof value === "object" &&
            "message" in value &&
            typeof value.message === "string"
          ? value.message
          : "无可公开错误信息";
  return redactSensitiveText(message).replaceAll(serviceSecret, "<已隐藏>").slice(0, 400);
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          Reflect.get(globalThis, Symbol.for("coremind.mcpStartup.capture"))?.()?.(
            "bounded_timeout",
          );
          reject(new Error(`MCP 真实验收阶段超时（${label}）`));
        }, 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
