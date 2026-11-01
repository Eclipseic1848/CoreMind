import "../../../test/setup-env.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "coremind-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRunStore } from "./run-state.js";
import { type TaskDefinition, type TaskRuntimeOptions, TaskSession } from "./task-session.js";

let workspace: string;
let session: TaskSession | undefined;
let executions: number;
let runtime: TaskRuntimeOptions;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-calls-"));
  executions = 0;
  runtime = {
    authorityVersion: "policy-1",
    configDir: workspace,
    approveTool: async () => "allow",
    config: validateConfig({
      schemaVersion: 2,
      name: "稳定键夹具",
      defaultAgent: "main",
      provider: {
        id: "local-probe",
        model: "probe",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
        baseUrl: "http://127.0.0.1:1/v1",
      },
      agents: { main: {} },
      runtime: { maxTurns: 4, maxRetries: 0, runTimeoutMs: 10_000, maxToolCalls: 2 },
      permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    }),
    toolDefinitions: [
      {
        name: "probe",
        description: "计数读取",
        parameters: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
        effect: { operations: ["read"], reversible: true },
        execute: async (args) => {
          executions += 1;
          return { text: `值${args.value}`, details: { count: executions } };
        },
      },
    ],
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await session?.close();
  session = undefined;
  await rm(workspace, { recursive: true, force: true });
});

function definition(handler: TaskDefinition["phases"][string]): TaskDefinition {
  return {
    type: "calls",
    version: 1,
    initialPhase: "a",
    checkpointSchema: { type: "string" },
    phases: { a: handler, b: handler },
  };
}
async function open(def: TaskDefinition) {
  session = await TaskSession.open({ workspace, sessionId: "calls", runtime, definitions: [def] });
  if (!session.query("job"))
    await session.start({ taskId: "job", type: "calls", checkpoint: "initial" });
  return session;
}

describe("持久稳定键工具调用", () => {
  it("审批回调抛出 undefined 时不能记录成功或推进阶段", async () => {
    runtime.approveTool = async () => {
      throw undefined;
    };
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) =>
          executeTool("read", "probe", { value: 1 }),
        );
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toBeDefined();
    expect(tasks.query("job")).toMatchObject({ status: "paused", checkpoint: "initial" });
    expect(tasks.calls("job")).not.toContainEqual(expect.objectContaining({ status: "completed" }));
    expect(executions).toBe(0);
  });
  it("处理器抛出 undefined 也不能被当成成功并推进阶段", async () => {
    const tasks = await open(
      definition(async (context) => {
        await context
          .runCalls(async () => {
            throw undefined;
          })
          .catch(() => undefined);
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toBeUndefined();
    expect(tasks.query("job")).toMatchObject({ status: "paused", checkpoint: "initial" });
    expect(executions).toBe(0);
    const facts = await new FileRunStore(path.join(workspace, ".coremind/runs")).read(
      tasks.query("job")!.pendingRunId!,
    );
    expect(facts.find((fact) => fact.kind === "pause")?.payload).toMatchObject({
      outcome: { status: "paused" },
    });
  });
  it.each(["count", "credentials"])("delegate 的 %s 硬边界不因稳定键入口扩大", async (kind) => {
    const budget = {
      tokens: 100,
      toolCalls: 0,
      costUsd: 0.1,
      wallTimeMs: 1000,
      steps: 1,
      descendants: 0,
    };
    runtime.config = validateConfig({
      ...runtime.config,
      runtime: { ...runtime.config.runtime, maxTokens: 1000, maxCostUsd: 1 },
      agents: {
        main: {
          delegation: {
            budget: { ...budget, descendants: 1 },
            limits: { maxActiveChildren: kind === "count" ? 0 : 1 },
            targets: { worker: { budget } },
          },
        },
        worker: {},
      },
    });
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          await executeTool("child", "delegate", {
            target: "worker",
            task: "受限任务",
            references: [],
            ...(kind === "credentials" ? { credentials: ["HOST_SECRET"] } : {}),
          });
          return null;
        });
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toThrow();
    expect(executions).toBe(0);
    const facts = await new FileRunStore(path.join(workspace, ".coremind/runs")).read(
      tasks.calls("job")[0]!.runId,
    );
    const text = JSON.stringify(facts);
    expect(text).toContain(
      kind === "count" ? "child_run_concurrency_limit" : "child_run_policy_escalation",
    );
    expect(text).not.toContain('"type":"model_request"');
    expect(tasks.calls("job")[0]?.status).toBe("failed");
  });
  it.each([false, true])(
    "结果账本写入确认失败，afterWrite=%s，不发布部分阶段或再次执行",
    async (afterWrite) => {
      const def = definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          await executeTool("one", "probe", { value: 1 });
          return null;
        });
        return { phase: "a", checkpoint: "完成", done: true };
      });
      const tasks = await open(def);
      const commit = FileRunStore.prototype.commit;
      let injected = false;
      vi.spyOn(FileRunStore.prototype, "commit").mockImplementation(
        async function (record, durability) {
          if (
            !injected &&
            record.kind === "task_commit" &&
            JSON.stringify(record.payload).includes('"status":"completed","result"')
          ) {
            injected = true;
            if (afterWrite) await commit.call(this, record, durability);
            throw new Error("结果提交确认故障");
          }
          return commit.call(this, record, durability);
        },
      );
      await expect(tasks.resume("job")).rejects.toThrow();
      expect(injected).toBe(true);
      expect(() => tasks.query("job")).toThrow();
      await tasks.close();
      vi.restoreAllMocks();
      const reopened = await open(def);
      expect(reopened.query("job")?.checkpoint).toBe("initial");
      expect(reopened.calls("job")[0]?.status).toBe(afterWrite ? "completed" : "pending");
      await expect(reopened.resume("job")).rejects.toThrow();
      expect(executions).toBe(1);
    },
  );
  it("不同父任务、阶段和迁移版本隔离键；历史结果继续可查", async () => {
    const handler: TaskDefinition["phases"][string] = async (context) => {
      await context.runCalls(async ({ executeTool }) => {
        await executeTool("one", "probe", { value: 1 });
        return null;
      });
      return { phase: "b", checkpoint: "next", done: context.task.phase === "b" };
    };
    const def = definition(handler);
    const tasks = await open(def);
    await tasks.resume("job");
    await tasks.start({ taskId: "other", type: "calls", checkpoint: "initial" });
    await tasks.resume("other");
    expect(executions).toBe(2);
    await tasks.close();
    const next = await open({
      ...def,
      version: 2,
      migrate: (old) => ({ phase: "b", checkpoint: old.checkpoint }),
    });
    await next.resume("job");
    expect(executions).toBe(3);
    expect(next.calls("job").map((call) => [call.key, call.phase, call.version])).toEqual([
      ["one", "a", 1],
      ["one", "b", 2],
    ]);
    expect(next.calls("job")[0]?.runId).not.toBe(next.calls("other")[0]?.runId);
  });

  it("在飞重复键参数冲突不能连接错误结果", async () => {
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          const first = executeTool("one", "probe", { value: 1 });
          await expect(executeTool("one", "probe", { value: 2 })).rejects.toMatchObject({
            code: "task_call_conflict",
          });
          await first;
          return null;
        });
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_call_conflict" });
    expect(executions).toBe(1);
  });

  it("完成结果不能在能力声明变化后复用", async () => {
    const def = definition(async (context) => {
      await context.runCalls(async ({ executeTool }) => {
        await executeTool("one", "probe", { value: 1 });
        return null;
      });
      throw new Error("保持未提交阶段");
    });
    const tasks = await open(def);
    await expect(tasks.resume("job")).rejects.toThrow("保持未提交阶段");
    await tasks.close();
    runtime.toolDefinitions![0]!.capability = {
      effect: "none",
      replay: "safe",
      concurrency: "parallel",
      checkpoint: "none",
      durability: "ordinary",
    };
    const changed = await open(def);
    await expect(changed.resume("job")).rejects.toMatchObject({ code: "task_authority_mismatch" });
    expect(executions).toBe(1);
  });

  it.each(["schema", "network", "path"])("%s 拒绝发生在副作用前", async (kind) => {
    let tool = "probe";
    let args: Record<string, string> = { value: "wrong" };
    if (kind === "network") {
      runtime.toolDefinitions![0]!.effect = { operations: ["network"], reversible: false };
    }
    if (kind === "path") {
      runtime.config = validateConfig({ ...runtime.config, tools: [{ id: "write" }] });
      tool = "write";
      args = { path: path.join(workspace, "..", "outside-keyed.txt"), content: "不得写入" };
    }
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          await executeTool("one", tool, kind === "network" ? { value: 1 } : args);
          return null;
        });
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toThrow();
    expect(executions).toBe(0);
    expect(tasks.calls("job")[0]?.status).toBe("failed");
    if (kind === "path")
      await expect(readFile(args.path!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("取消中工具收到信号，关联调用保留 cancelled 且终态不重发", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    runtime.toolDefinitions![0]!.execute = async (_args, { signal }) => {
      executions += 1;
      entered();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("已取消")), { once: true });
      });
    };
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          await executeTool("one", "probe", { value: 1 });
          return null;
        });
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    const work = tasks.resume("job");
    const rejected = expect(work).rejects.toThrow();
    await ready;
    expect(await tasks.cancel("job")).toMatchObject({ status: "cancelled" });
    await rejected;
    expect(tasks.calls("job")[0]?.status).toBe("cancelled");
    await tasks.resume("job");
    expect(executions).toBe(1);
  });
  it("重复键连接原调用；同 Run 两个不同键只执行两次并保留完整结果", async () => {
    const tasks = await open(
      definition(async (context) => {
        const value = await context.runCalls(async ({ executeTool }) => {
          const first = executeTool("one", "probe", { value: 1 });
          expect(await executeTool("one", "probe", { value: 1 })).toEqual(await first);
          const cached = await executeTool("one", "probe", { value: 1 });
          cached.details = "篡改副本";
          expect((await executeTool("one", "probe", { value: 1 })).details).toEqual({ count: 1 });
          return (await executeTool("two", "probe", { value: 2 })).content[0]!.type;
        });
        return { phase: "a", checkpoint: value, done: true };
      }),
    );
    expect(await tasks.resume("job")).toMatchObject({ status: "completed", checkpoint: "text" });
    expect(executions).toBe(2);
    const calls = tasks.calls("job");
    expect(calls.map((call) => call.status)).toEqual(["completed", "completed"]);
    expect(new Set(calls.map((call) => call.runId)).size).toBe(1);
    expect(await tasks.resume("job")).toMatchObject({ status: "completed" });
    expect(executions).toBe(2);
  });

  it("结果已提交但阶段失败，重开复用结果且不请求 Provider", async () => {
    let stop = true;
    const def = definition(async (context) => {
      const value = await context.runCalls(async ({ executeTool }) => {
        const result = await executeTool("one", "probe", { value: 1 });
        return JSON.stringify(result);
      });
      if (stop) throw new Error("阶段提交前中断");
      return { phase: "a", checkpoint: value, done: true };
    });
    const tasks = await open(def);
    await expect(tasks.resume("job")).rejects.toThrow("阶段提交前中断");
    const result = tasks.calls("job")[0];
    await tasks.close();
    stop = false;
    const reopened = await open(def);
    expect(await reopened.resume("job")).toMatchObject({ status: "completed" });
    expect(reopened.calls("job")[0]).toEqual(result);
    expect(executions).toBe(1);
  });

  it.each(["args", "tool", "order", "omitted"])("恢复 %s 分歧拒绝并持久审计", async (kind) => {
    let changed = false;
    const def = definition(async (context) => {
      await context.runCalls(async ({ executeTool }) => {
        if (changed && kind === "omitted") return "遗漏";
        await executeTool(
          changed && kind === "order" ? "two" : "one",
          changed && kind === "tool" ? "other" : "probe",
          { value: changed && kind === "args" ? 2 : 1 },
        );
        return "完成";
      });
      throw new Error("保留阶段");
    });
    const tasks = await open(def);
    await expect(tasks.resume("job")).rejects.toThrow("保留阶段");
    changed = true;
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_call_conflict" });
    expect(executions).toBe(1);
    const log = await new FileRunStore(
      path.join(
        workspace,
        ".coremind/tasks",
        createHash("sha256").update("calls", "utf8").digest("hex"),
      ),
    ).read("commits");
    expect(tasks.calls("job")[0]?.status).toBe("completed");
    expect(JSON.stringify(log)).toContain("conflict");
  });

  it("多键共享原工具预算，吞掉拒绝也不能推进阶段", async () => {
    runtime.config = validateConfig({
      ...runtime.config,
      runtime: { ...runtime.config.runtime, maxToolCalls: 1 },
    });
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          await executeTool("one", "probe", { value: 1 });
          await executeTool("two", "probe", { value: 2 }).catch(() => undefined);
          return "不能成功";
        });
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toThrow();
    expect(executions).toBe(1);
    expect(tasks.query("job")).toMatchObject({ status: "paused", checkpoint: "initial" });
    expect(tasks.calls("job").map((call) => call.status)).toEqual(["completed", "failed"]);
  });

  it("写工具审批拒绝不执行，失败结果保持可查询", async () => {
    runtime.config = validateConfig({ ...runtime.config, tools: [{ id: "write" }] });
    runtime.approveTool = vi.fn(async () => "deny" as const);
    const tasks = await open(
      definition(async (context) => {
        await context.runCalls(async ({ executeTool }) => {
          await executeTool("one", "write", { path: "denied.txt", content: "不能写入" });
          return null;
        });
        return { phase: "a", checkpoint: "错误", done: true };
      }),
    );
    await expect(tasks.resume("job")).rejects.toThrow();
    expect(runtime.approveTool).toHaveBeenCalled();
    expect(executions).toBe(0);
    expect(tasks.calls("job")[0]?.status).toBe("failed");
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_call_unresolved" });
    expect(executions).toBe(0);
  });
});
