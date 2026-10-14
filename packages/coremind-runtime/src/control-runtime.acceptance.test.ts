import "../../../test/setup-env.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "./chat-session.js";
import { ControlInbox, type RunControlCommand } from "./control-inbox.js";
import type { CoreMindEvent } from "./events.js";
import type { RunId } from "./ids.js";
import { controlInputId, foldInputReceipts, type InputId } from "./input-receipt.js";
import { FileRunStore, RunStateJournal, type RunStateRecord } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

type InputControl = "steering" | "follow_up";
type WireRequest = { messages: Array<{ role: string; content?: unknown }> };

describe("运行中控制的真实交付与恢复", () => {
  it.each(["steering", "follow_up"] as const)(
    "ChatSession 的 %s 提交后才交付，重复与旧 Run 不会误投",
    async (type) => {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-delivery-"));
      const firstRequest = deferred<void>();
      const releaseFirst = deferred<void>();
      const appliedEntered = deferred<void>();
      const releaseApplied = deferred<void>();
      const nextRequest = deferred<void>();
      const releaseNext = deferred<void>();
      let firstRunId = "";
      const store = new FileRunStore(path.join(directory, "runs"), {
        beforeCommit: ({ record }) => {
          if (record?.kind === "start" && !firstRunId) firstRunId = record.runId;
        },
        beforeBarrier: async ({ record }) => {
          if (
            record?.kind === "control" &&
            (record.payload as { state?: string }).state === "applied"
          ) {
            appliedEntered.resolve();
            await releaseApplied.promise;
          }
        },
      });
      const requests: WireRequest[] = [];
      const errors: unknown[] = [];
      const server = provider(async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          firstRequest.resolve();
          await releaseFirst.promise;
        }
        if (requests.length === 3) {
          nextRequest.resolve();
          await releaseNext.promise;
        }
        return "本轮正常完成";
      }, errors);
      let chat: ChatSession | undefined;
      let nextChat: ChatSession | undefined;
      let running: Promise<unknown> | undefined;
      try {
        await listen(server);
        const runtime = await CoreMindRuntime.create({
          config: configFor(server),
          configDir: directory,
          cwd: directory,
          runStore: store,
        });
        chat = new ChatSession(runtime, "main");
        running = chat.chat("第一轮输入");
        await bounded(firstRequest.promise);
        expect(firstRunId).not.toBe("");
        const message = `唯一控制正文-${type}`;
        const options = { controlId: "same-control", runId: firstRunId };
        let acknowledged = false;
        const delivery = send(chat, type, message, options).then((receipt) => {
          acknowledged = true;
          return receipt;
        });
        await bounded(appliedEntered.promise);
        expect(requests).toHaveLength(1);
        expect(acknowledged).toBe(false);
        const duplicate = send(chat, type, message, options);
        const conflict = send(chat, type, "冲突正文不得交付", options);
        releaseApplied.resolve();
        expect(await bounded(delivery)).toMatchObject({ runId: firstRunId, status: "applied" });
        expect(await bounded(duplicate)).toMatchObject({
          status: "duplicate",
          duplicateOf: "applied",
        });
        expect(await bounded(conflict)).toMatchObject({ status: "conflict" });
        releaseFirst.resolve();
        const result = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
        expect(result.run.outcome.status).toBe("succeeded");
        expect(requests).toHaveLength(2);
        expect(userTexts(requests[1]!).filter((text) => text === message)).toHaveLength(1);
        expect(requestText(requests[1]!)).not.toContain("冲突正文不得交付");
        const records = await store.read(firstRunId);
        expect(
          controlFacts(records, options.controlId).map((record) => record.payload.state),
        ).toEqual(["accepted", "applied"]);
        assertInput(records, firstRunId, options.controlId, "completed");

        nextChat = new ChatSession(runtime, "main");
        running = nextChat.chat("第二轮独立输入");
        await bounded(nextRequest.promise);
        await expect(send(chat, type, "旧 Run 的迟到消息", options)).rejects.toMatchObject({
          code: expect.stringMatching(/^control_(?:invalid|run_mismatch|unavailable)$/u),
        });
        releaseNext.resolve();
        const next = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
        expect(next.run.outcome.status).toBe("succeeded");
        expect(next.run.runId).not.toBe(firstRunId);
        expect(requestText(requests[2]!)).not.toContain(message);
        expect(requestText(requests[2]!)).not.toContain("旧 Run 的迟到消息");
        expect(controlFacts(await store.read(next.run.runId), options.controlId)).toEqual([]);
        expect(errors).toEqual([]);
      } finally {
        chat?.abort();
        nextChat?.abort();
        releaseApplied.resolve();
        releaseFirst.resolve();
        releaseNext.resolve();
        if (running) await bounded(running).catch(() => undefined);
        await close(server);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("applied 提交晚于 Agent 自然结束时只丢弃原 Run 控制", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-natural-end-"));
    const firstRequest = deferred<void>();
    const releaseFirst = deferred<void>();
    const appliedEntered = deferred<void>();
    const releaseApplied = deferred<void>();
    const turnEnded = deferred<void>();
    const sealEntered = deferred<void>();
    let firstRunId = "";
    let sealCompleted = false;
    let runCompleted = false;
    let acknowledged = false;
    const store = new FileRunStore(path.join(directory, "runs"), {
      beforeCommit: ({ record }) => {
        if (record?.kind === "start" && !firstRunId) firstRunId = record.runId;
      },
      beforeBarrier: async ({ record }) => {
        if (
          record?.kind === "control" &&
          (record.payload as { state?: string }).state === "applied"
        ) {
          appliedEntered.resolve();
          await releaseApplied.promise;
        }
      },
    });
    const originalSeal = ControlInbox.prototype.sealForTerminal;
    const seal = vi
      .spyOn(ControlInbox.prototype, "sealForTerminal")
      .mockImplementation(async function (this: ControlInbox) {
        sealEntered.resolve();
        await originalSeal.call(this);
        sealCompleted = true;
      });
    const requests: WireRequest[] = [];
    const errors: unknown[] = [];
    const server = provider(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        firstRequest.resolve();
        await releaseFirst.promise;
      }
      return "原请求自然完成";
    }, errors);
    let chat: ChatSession | undefined;
    let running: Promise<unknown> | undefined;
    let delivery: ReturnType<ChatSession["followUp"]> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      await listen(server);
      const runtime = await CoreMindRuntime.create({
        config: configFor(server),
        configDir: directory,
        cwd: directory,
        runStore: store,
      });
      chat = new ChatSession(runtime, "main");
      unsubscribe = chat.onEvent((event) => {
        if (event.type === "turn_end") turnEnded.resolve();
      });
      running = chat.chat("自然结束前的原输入").then((result) => {
        runCompleted = true;
        return result;
      });
      await bounded(firstRequest.promise);
      expect(firstRunId).not.toBe("");
      const controlId = "natural-end-control";
      const message = "自然结束后只能丢弃的控制正文";
      delivery = chat.followUp(message, { runId: firstRunId, controlId }).then((receipt) => {
        acknowledged = true;
        return receipt;
      });
      await bounded(appliedEntered.promise);
      releaseFirst.resolve();
      await bounded(turnEnded.promise);
      // 真实 prompt 已退出，私有 agent_end 已关闭准入；封口仍等候原 applied 提交。
      await bounded(sealEntered.promise);
      expect(sealCompleted).toBe(false);
      expect(runCompleted).toBe(false);
      expect(acknowledged).toBe(false);
      expect(requests).toHaveLength(1);
      releaseApplied.resolve();
      expect(await bounded(delivery)).toMatchObject({ runId: firstRunId, status: "applied" });
      const result = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
      expect(result.run.outcome.status).toBe("succeeded");
      expect(sealCompleted).toBe(true);
      expect(result.events.some((event) => event.type === "quiescence_timeout")).toBe(false);
      expect(requests).toHaveLength(1);
      const records = await store.read(firstRunId);
      expect(controlFacts(records, controlId).map((record) => record.payload.state)).toEqual([
        "accepted",
        "applied",
      ]);
      assertInput(records, firstRunId, controlId, "discarded");
      await expect(
        chat.steer("终态后不得接受 steering", { controlId: "late-steering" }),
      ).rejects.toMatchObject({ code: "control_unavailable" });
      await expect(
        chat.followUp("终态后不得接受 follow_up", { controlId: "late-follow-up" }),
      ).rejects.toMatchObject({ code: "control_unavailable" });
      expect(await store.read(firstRunId)).toEqual(records);
      expect(requests).toHaveLength(1);
      running = chat.chat("同一会话的下一轮独立输入");
      const next = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
      expect(next.run.outcome.status).toBe("succeeded");
      expect(next.run.runId).not.toBe(firstRunId);
      expect(requests).toHaveLength(2);
      expect(requestText(requests[1]!)).not.toContain(message);
      expect(requestText(requests[1]!)).not.toContain("终态后不得接受");
      const nextRecords = await store.read(next.run.runId);
      for (const id of [controlId, "late-steering", "late-follow-up"])
        expect(controlFacts(nextRecords, id)).toEqual([]);
      expect(next.events.some((event) => event.type === "quiescence_timeout")).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      chat?.abort();
      releaseApplied.resolve();
      releaseFirst.resolve();
      if (delivery) await bounded(delivery).catch(() => undefined);
      if (running) await bounded(running).catch(() => undefined);
      unsubscribe?.();
      seal.mockRestore();
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["accepted", "applied"] as const)(
    "%s 关键提交失败时真实模型永远收不到控制正文",
    async (state) => {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-commit-failure-"));
      const entered = deferred<void>();
      const release = deferred<void>();
      const failure = new Error(`${state} 控制关键提交失败`);
      const store = new FileRunStore(path.join(directory, "runs"), {
        beforeBarrier: ({ record }) => {
          if (record?.kind === "control" && (record.payload as { state?: string }).state === state)
            throw failure;
        },
      });
      const requests: WireRequest[] = [];
      const errors: unknown[] = [];
      const server = provider(async (request) => {
        requests.push(request);
        entered.resolve();
        await release.promise;
        return "模型结束";
      }, errors);
      let chat: ChatSession | undefined;
      let running: Promise<unknown> | undefined;
      try {
        await listen(server);
        const runtime = await CoreMindRuntime.create({
          config: configFor(server),
          configDir: directory,
          cwd: directory,
          runStore: store,
        });
        chat = new ChatSession(runtime, "main");
        running = chat.chat("原输入");
        await bounded(entered.promise);
        const projection = await chat.inspectCurrentRunProjection();
        const runId = projection!.runId;
        await expect(
          chat.followUp("不可交付的正文", { runId, controlId: "failed-delivery" }),
        ).rejects.toThrow(failure.message);
        release.resolve();
        const result = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
        expect(result.run.outcome.status).not.toBe("succeeded");
        expect(requests).toHaveLength(1);
        expect(requests.map(requestText).join("\n")).not.toContain("不可交付的正文");
        expect(
          controlFacts(await store.read(runId), "failed-delivery").map(
            (record) => record.payload.state,
          ),
        ).toEqual(state === "accepted" ? [] : ["accepted"]);
        expect(errors).toEqual([]);
      } finally {
        chat?.abort();
        release.resolve();
        if (running) await bounded(running).catch(() => undefined);
        await close(server);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("控制账本失效后已排队输入不得触发下一轮模型请求", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-poison-next-model-"));
    const entered = deferred<void>();
    const releaseFirst = deferred<void>();
    const requests: WireRequest[] = [];
    const errors: unknown[] = [];
    const store = new FileRunStore(path.join(directory, "runs"), {
      beforeBarrier: ({ record }) => {
        if (record?.kind !== "control") return;
        const fact = record.payload as { controlId?: string; state?: string };
        if (fact.controlId === "failed-control-b" && fact.state === "applied") {
          throw new Error("B 的 applied 关键提交失败");
        }
      },
    });
    const server = provider(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve();
        await releaseFirst.promise;
      }
      return "当前模型响应结束";
    }, errors);
    let chat: ChatSession | undefined;
    let running: Promise<unknown> | undefined;
    try {
      await listen(server);
      const runtime = await CoreMindRuntime.create({
        config: configFor(server),
        configDir: directory,
        cwd: directory,
        runStore: store,
      });
      chat = new ChatSession(runtime, "main");
      running = chat.chat("首轮原始输入");
      await bounded(entered.promise);
      expect(
        await chat.followUp("A 已确认交付，等候后续消费", { controlId: "queued-control-a" }),
      ).toMatchObject({ status: "applied" });
      await expect(
        chat.followUp("B 不得交付", { controlId: "failed-control-b" }),
      ).rejects.toMatchObject({
        code: "durability_barrier_failed",
        message: expect.stringContaining("B 的 applied 关键提交失败"),
      });
      expect(requests).toHaveLength(1);
      releaseFirst.resolve();
      const result = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
      expect(result.run.outcome).toMatchObject({
        status: "failed",
        error: { code: "durability_barrier_failed" },
      });
      expect(requests).toHaveLength(1);
      expect(requests.map(requestText).join("\n")).not.toContain("B 不得交付");
      expect(errors).toEqual([]);
    } finally {
      chat?.abort();
      releaseFirst.resolve();
      if (running) await bounded(running).catch(() => undefined);
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["steering", "follow_up"] as const)(
    "审批中的 %s 不代替工具批准，并遵守各自消费边界",
    async (type) => {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-approval-"));
      await writeFile(path.join(directory, "note.txt"), "真实工具读取内容", "utf8");
      const approvalEntered = deferred<void>();
      const approve = deferred<"allow">();
      const requests: WireRequest[] = [];
      const errors: unknown[] = [];
      const server = provider(async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { tool: "read", args: { path: "note.txt" } }
          : "工具轮次正常完成";
      }, errors);
      let chat: ChatSession | undefined;
      let running: Promise<unknown> | undefined;
      let approvals = 0;
      try {
        await listen(server);
        const runtime = await CoreMindRuntime.create({
          config: {
            ...configFor(server),
            tools: [{ id: "read" }],
            permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
          },
          configDir: directory,
          cwd: directory,
          approveTool: async () => {
            approvals++;
            approvalEntered.resolve();
            return approve.promise;
          },
        });
        chat = new ChatSession(runtime, "main");
        running = chat.chat("读取项目文件");
        await bounded(approvalEntered.promise);
        const receipt = await send(chat, type, "审批期控制正文", { controlId: "approval-control" });
        expect(receipt.status).toBe("applied");
        expect(approvals).toBe(1);
        expect(requests).toHaveLength(1);
        approve.resolve("allow");
        const result = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
        expect(result.run.outcome.status).toBe("succeeded");
        expect(requestText(requests[1]!)).toContain("真实工具读取内容");
        expect(userTexts(requests[1]!).includes("审批期控制正文")).toBe(type === "steering");
        expect(requests).toHaveLength(type === "steering" ? 2 : 3);
        if (type === "follow_up") expect(userTexts(requests[2]!)).toContain("审批期控制正文");
        expect(result.events.filter((event) => event.type === "approval_resolved")).toMatchObject([
          { decision: "allow" },
        ]);
        expect(errors).toEqual([]);
      } finally {
        chat?.abort();
        approve.resolve("allow");
        if (running) await bounded(running).catch(() => undefined);
        await close(server);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["accepted", "applied"] as const)(
    "冷恢复 %s 控制只按持久事实消费或丢弃",
    async (state) => {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-restore-"));
      const runId = "restore-input-control";
      const controlId = "restore-control";
      const message = "只允许确认一次的恢复输入";
      const requests: WireRequest[] = [];
      const errors: unknown[] = [];
      const server = provider(async (request) => {
        requests.push(request);
        return requests.length === 1
          ? { tool: "read", args: { path: "denied.txt" } }
          : "恢复执行完成";
      }, errors);
      try {
        await listen(server);
        const config: CoreMindConfig = {
          ...configFor(server),
          tools: [{ id: "read" }],
          permissions: { mode: "ask", deny: ["read"], workspaceOnly: true, network: "deny" },
        };
        const store = new FileRunStore(path.join(directory, "runs"));
        const options = {
          config,
          configDir: directory,
          cwd: directory,
          runStore: store,
          initialPrompt: "原始恢复输入",
        };
        expect(
          (await (await CoreMindRuntime.create({ ...options, runId })).run()).outcome.status,
        ).toBe("paused");
        const prior = await store.read(runId);
        const command: RunControlCommand = {
          schemaVersion: 1,
          runId,
          controlId,
          type: "follow_up",
          message,
        };
        const offline = new ControlInbox({
          runId: runId as RunId,
          journal: new RunStateJournal(runId, store, prior.at(-1)!.sequence),
          records: prior,
          apply: async () => state,
        });
        expect((await offline.accept(command)).status).toBe(state);
        // applied 已提交但尚未进入原生队列，模拟持久提交与内存交付之间的进程中断。
        const resumed = await CoreMindRuntime.create({ ...options, resumeRunId: runId });
        const result = await resumed.run();
        expect(result.outcome.status).toBe("succeeded");
        const records = await store.read(runId);
        const delivered = requests
          .slice(1)
          .filter((request) => userTexts(request).includes(message));
        expect(delivered).toHaveLength(state === "accepted" ? 1 : 0);
        assertInput(records, runId, controlId, state === "accepted" ? "completed" : "discarded");
        expect(controlFacts(records, controlId).map((record) => record.payload.state)).toEqual([
          "accepted",
          "applied",
        ]);
        expect(errors).toEqual([]);
      } finally {
        await close(server);
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("审批拒绝只丢弃未消费的控制，原输入仍可恢复且不会重投控制", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-paused-restore-"));
    const approvalEntered = deferred<void>();
    const deny = deferred<"deny">();
    const requests: WireRequest[] = [];
    const errors: unknown[] = [];
    const server = provider(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? { tool: "read", args: { path: "unapproved.txt" } }
        : "恢复后正常完成";
    }, errors);
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      await listen(server);
      const runId = "paused-with-discarded-control";
      const controlId = "unconsumed-follow-up";
      const message = "暂停恢复时不得重投的控制正文";
      const config: CoreMindConfig = {
        ...configFor(server),
        tools: [{ id: "read" }],
        permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
      };
      const store = new FileRunStore(path.join(directory, "runs"));
      const options = {
        config,
        configDir: directory,
        cwd: directory,
        runStore: store,
        initialPrompt: "原始已认领输入",
      };
      const runtime = await CoreMindRuntime.create({
        ...options,
        runId,
        signal: controller.signal,
        approveTool: async () => {
          approvalEntered.resolve();
          return deny.promise;
        },
      });
      running = runtime.run();
      await bounded(approvalEntered.promise);
      expect(
        await runtime.acceptControl({
          schemaVersion: 1,
          runId,
          controlId,
          type: "follow_up",
          message,
        }),
      ).toMatchObject({ status: "applied" });
      deny.resolve("deny");
      const paused = (await bounded(running)) as Awaited<ReturnType<CoreMindRuntime["run"]>>;
      expect(paused.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
      const prior = await store.read(runId);
      assertInput(prior, runId, controlId, "discarded");
      const inputEvents = prior.flatMap((record) =>
        record.kind === "event" ? [(record.payload as { event: CoreMindEvent }).event] : [],
      );
      const initial = inputEvents.find(
        (event) =>
          event.type === "input_receipt" && event.inputId !== controlInputId(runId, controlId),
      );
      if (initial?.type !== "input_receipt") throw new Error("缺少原输入收据");
      expect(foldInputReceipts(inputEvents).get(initial.inputId as InputId)).toBe("claimed");
      expect(paused.snapshot.resumable).toBe(true);
      expect(requests).toHaveLength(1);
      const resumed = await CoreMindRuntime.create({ ...options, resumeRunId: runId });
      const completed = await resumed.run();
      expect(completed.runId).toBe(runId);
      expect(completed.outcome.status).toBe("succeeded");
      expect(requests).toHaveLength(2);
      expect(requests.map(requestText).join("\n")).not.toContain(message);
      const records = await store.read(runId);
      assertInput(records, runId, controlId, "discarded");
      expect(controlFacts(records, controlId).map((record) => record.payload.state)).toEqual([
        "accepted",
        "applied",
      ]);
      expect(errors).toEqual([]);
    } finally {
      controller.abort();
      deny.resolve("deny");
      if (running) await bounded(running).catch(() => undefined);
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("applied 提交期间取消只丢弃旧 Run 输入，下一 Run 不会消费它", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-cancel-"));
    const entered = deferred<void>();
    const releaseResponse = deferred<void>();
    const appliedEntered = deferred<void>();
    const releaseApplied = deferred<void>();
    const requests: WireRequest[] = [];
    const errors: unknown[] = [];
    const store = new FileRunStore(path.join(directory, "runs"), {
      beforeBarrier: async ({ record }) => {
        if (
          record?.kind === "control" &&
          (record.payload as { state?: string }).state === "applied"
        ) {
          appliedEntered.resolve();
          await releaseApplied.promise;
        }
      },
    });
    const server = provider(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        entered.resolve();
        await releaseResponse.promise;
      }
      return "正常结束";
    }, errors);
    let chat: ChatSession | undefined;
    let running: Promise<unknown> | undefined;
    try {
      await listen(server);
      const runtime = await CoreMindRuntime.create({
        config: configFor(server),
        configDir: directory,
        cwd: directory,
        runStore: store,
      });
      chat = new ChatSession(runtime, "main");
      running = chat.chat("等待期间取消");
      await bounded(entered.promise);
      const delivery = chat.followUp("取消后不得重投", { controlId: "cancel-control" });
      await bounded(appliedEntered.promise);
      chat.abort();
      releaseApplied.resolve();
      expect(await bounded(delivery)).toMatchObject({ status: "applied" });
      releaseResponse.resolve();
      const result = (await bounded(running)) as Awaited<ReturnType<ChatSession["chat"]>>;
      expect(result.run.outcome.status).toBe("aborted");
      expect(result.events.some((event) => event.type === "quiescence_timeout")).toBe(false);
      assertInput(
        await store.read(result.run.runId),
        result.run.runId,
        "cancel-control",
        "discarded",
      );
      const next = await new ChatSession(runtime, "main").chat("下一轮独立输入");
      expect(next.run.outcome.status).toBe("succeeded");
      expect(requests).toHaveLength(2);
      expect(requestText(requests[1]!)).not.toContain("取消后不得重投");
      expect(errors).toEqual([]);
    } finally {
      chat?.abort();
      releaseApplied.resolve();
      releaseResponse.resolve();
      if (running) await bounded(running).catch(() => undefined);
      await close(server);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function send(
  session: ChatSession,
  type: InputControl,
  message: string,
  options: { controlId?: string; runId?: string },
) {
  return type === "steering" ? session.steer(message, options) : session.followUp(message, options);
}

function configFor(server: ReturnType<typeof createServer>): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "运行中控制真实验收",
    provider: {
      id: "probe",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents: { main: {} },
    runtime: { maxTurns: 5, maxRetries: 0, runTimeoutMs: 10_000 },
  };
}

function assertInput(
  records: RunStateRecord[],
  runId: string,
  controlId: string,
  status: "completed" | "discarded",
) {
  const inputId = controlInputId(runId, controlId);
  const events = records.flatMap((record) =>
    record.kind === "event" ? [(record.payload as { event: CoreMindEvent }).event] : [],
  );
  const receipts = events.filter((event) => "inputId" in event && event.inputId === inputId);
  expect(foldInputReceipts(events).get(inputId)).toBe(status);
  expect(receipts.map((event) => event.type)).toEqual(
    status === "completed"
      ? ["input_receipt", "input_claimed", "input_completed"]
      : ["input_receipt", "input_discarded"],
  );
  if (status === "completed") {
    const claimed = receipts.find((event) => event.type === "input_claimed")!;
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn_end",
        turnId: "turnId" in claimed ? claimed.turnId : undefined,
      }),
    );
  }
}

function controlFacts(records: RunStateRecord[], controlId: string) {
  return records.filter(
    (record) =>
      record.kind === "control" &&
      (record.payload as { controlId?: string }).controlId === controlId,
  ) as Array<RunStateRecord & { payload: { state: string } }>;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("控制验收等待明确阶段超时")), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function userTexts(request: WireRequest): string[] {
  return request.messages
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
}

function requestText(request: WireRequest): string {
  return request.messages.map((message) => textOf(message.content)).join("\n");
}

function textOf(value: unknown): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part: { text?: string }) => part.text ?? "").join("")
      : "";
}

function provider(
  reply: (request: WireRequest) => Promise<string | { tool: string; args: unknown }>,
  errors: unknown[],
) {
  let ordinal = 0;
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void (async () => {
        const result = await reply(JSON.parse(body));
        if (response.destroyed) return;
        const id = `control-${++ordinal}`;
        const delta =
          typeof result === "string"
            ? { role: "assistant", content: result }
            : {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `${id}-call`,
                    type: "function",
                    function: { name: result.tool, arguments: JSON.stringify(result.args) },
                  },
                ],
              };
        sendSse(response, [
          { id, choices: [{ index: 0, delta, finish_reason: null }] },
          {
            id,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: typeof result === "string" ? "stop" : "tool_calls",
              },
            ],
          },
        ]);
      })().catch((error: unknown) => {
        errors.push(error);
        if (!response.destroyed) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "控制夹具失败" } }));
        }
      });
    });
  });
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
