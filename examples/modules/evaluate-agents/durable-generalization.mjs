import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { TaskSession } from "coremind-ai";
import { taskExample } from "../embed-coremind-python/task-host.mjs";

const lookupSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
  additionalProperties: false,
};

function options(workspace, _type) {
  const original = taskExample(workspace);
  const increment = ({ task }) => ({ phase: "b", checkpoint: task.checkpoint + 1 });
  const definitions = [
    {
      type: "counter",
      version: 1,
      initialPhase: "a",
      checkpointSchema: { type: "integer" },
      phases: { a: increment, b: (ctx) => ({ ...increment(ctx), done: true }) },
    },
    {
      type: "alarm-demo",
      version: 1,
      initialPhase: "a",
      checkpointSchema: { type: "integer" },
      phases: {
        a: (ctx) => ({ ...increment(ctx), sleepUntil: 1234 }),
        b: (ctx) => ({ ...increment(ctx), done: true }),
      },
    },
    {
      type: "lookup",
      version: 1,
      initialPhase: "read",
      checkpointSchema: lookupSchema,
      phases: {
        async read(ctx) {
          const checkpoint = await ctx.runCalls(async ({ executeTool }) => {
            await executeTool("one", "lookup", ctx.task.checkpoint);
            const result = await executeTool("one", "lookup", ctx.task.checkpoint);
            return { id: result.content[0].text };
          });
          return { phase: "read", checkpoint, done: true };
        },
      },
    },
    ...original.definitions,
  ];
  let calls = 0;
  return {
    calls: () => calls,
    sessionOptions: {
      workspace,
      sessionId: "suite",
      clock: () => 1234,
      definitions,
      runtime: {
        ...original.runtime,
        configDir: workspace,
        env: { EVAL_LOCAL: "fixture" },
        config: {
          schemaVersion: 2,
          name: "离线任务",
          agents: { main: {} },
          provider: {
            id: "fixture",
            model: "unused",
            apiKeyEnv: "EVAL_LOCAL",
            baseUrl: "http://127.0.0.1:1/v1",
          },
          permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
          runtime: { maxToolCalls: 1, maxRetries: 0 },
        },
        approveTool: (request) =>
          request.tool === "lookup" ? "allow" : original.runtime.approveTool(request),
        toolDefinitions: [
          ...original.runtime.toolDefinitions,
          {
            name: "lookup",
            description: "返回提交的标识",
            parameters: lookupSchema,
            effect: { operations: ["read"], reversible: true },
            execute: async ({ id }) => {
              calls++;
              return { text: id };
            },
          },
        ],
      },
    },
  };
}

function cases(type, seed) {
  const lookup = type === "lookup";
  const values = lookup
    ? [
        "a",
        "客户甲",
        "0",
        " false ",
        "x".repeat(64),
        "{{agent}}",
        "a == b",
        "换\n行",
        '引号"',
        "🧭",
        "NULL",
        "001",
      ]
    : [0, 1, -1, -999, 65535, -2147483648, 2147483647, 42, -10, 10000, 255, 2];
  const valid = (i) => (lookup ? { id: values[i] } : values[i]);
  const rows = values.map((_, i) => ({
    category: i < 5 ? "boundary" : lookup ? "literal-input" : "normal",
    action: "complete",
    checkpoint: valid(i),
  }));
  for (const action of ["reopen", "terminal-replay", "cancel", "duplicate"]) {
    for (let i = 0; i < 3; i++) {
      const tag = ((Number(seed) >>> 0) % 65521) + i;
      rows.push({
        category: "composition",
        action,
        checkpoint: lookup ? { id: `任务-${tag}-${action}` } : tag,
      });
    }
  }
  const invalid = lookup
    ? [
        [{}, "required"],
        [{ id: "ok", extra: true }, "additionalProperties"],
        [{ id: "" }, "minLength"],
        [{ id: "x".repeat(65) }, "maxLength"],
        [{ id: null }, "type"],
        [{ id: 1 }, "type"],
        [null, "type"],
        ["abc", "type"],
        [[], "type"],
      ]
    : [
        [{}, "type"],
        [{ value: 1, extra: 1 }, "type"],
        ["1", "type"],
        [0.5, "type"],
        [null, "type"],
        [false, "type"],
        [[], "type"],
        ["{{1}}", "type"],
        ["-0", "type"],
      ];
  for (const [checkpoint, keyword] of invalid) {
    rows.push({ category: "schema", action: "invalid", checkpoint, keyword });
  }
  rows.push(
    { category: "missing", action: "missing" },
    { category: "constraint", action: "unknown", checkpoint: valid(0) },
    { category: "constraint", action: "invalid-id", checkpoint: valid(0) },
  );
  return rows;
}

export async function runDurableCases({ seed }) {
  const rows = [];
  const base = await realpath(tmpdir());
  for (const type of ["counter", "alarm-demo", "lookup", "example"]) {
    for (const [n, input] of cases(type, seed).entries()) {
      const start = performance.now();
      const workspace = await mkdtemp(path.join(base, "coremind-eval-durable-"));
      const { sessionOptions, calls } = options(workspace, type);
      let session;
      let actual;
      const { action, checkpoint, keyword } = input;
      const id = action === "invalid-id" ? "" : "job";
      const errorCode = {
        invalid: "task_checkpoint_invalid",
        missing: "task_checkpoint_invalid",
        "invalid-id": "task_checkpoint_invalid",
        unknown: "task_definition_unknown",
        duplicate: "task_already_exists",
      }[action];
      const expected = errorCode
        ? { code: errorCode, ...(keyword && { located: true }) }
        : action === "cancel"
          ? { status: "cancelled", checkpoint }
          : {
              status: "completed",
              checkpoint: type === "lookup" ? checkpoint : checkpoint + 2,
              ...(["example", "lookup"].includes(type) && { executions: 1 }),
            };
      try {
        session = await TaskSession.open(sessionOptions);
        const request = {
          taskId: id,
          type: action === "unknown" ? "unregistered" : type,
          ...(action !== "missing" && { checkpoint }),
        };
        await session.start(request);
        if (action === "duplicate") await session.start(request);
        let result = action === "cancel" ? await session.cancel(id) : await session.resume(id);
        if (action === "reopen") {
          await session.close();
          session = await TaskSession.open(sessionOptions);
          result = session.query(id);
        }
        if (result.status === "sleeping") {
          const wake = await session.wake(id, "alarm", result.sleep.sleepId);
          if (wake.status !== "accepted") throw new Error(`wake: ${wake.status}`);
        }
        if (!["completed", "cancelled"].includes(result.status) || action === "terminal-replay")
          result = await session.resume(id);
        if (action === "terminal-replay") result = await session.resume(id);
        actual = { status: result.status, checkpoint: result.checkpoint };
        if (action !== "cancel" && type === "lookup") actual.executions = calls();
        if (action !== "cancel" && type === "example")
          actual.executions = (await readFile(path.join(workspace, "canary.txt"), "utf8"))
            .trim()
            .split("\n").length;
      } catch (error) {
        actual = {
          code: error.code ?? error.message,
          ...(keyword && { located: error.message.includes(keyword) }),
        };
      } finally {
        try {
          await session?.close();
        } finally {
          await rm(workspace, { recursive: true, force: true });
        }
      }
      rows.push({
        id: `durable-${type}-${n + 1}`,
        type: `durable/${type}`,
        category: input.category,
        input,
        expected,
        actual,
        passed: isDeepStrictEqual(actual, expected),
        durationMs: Math.round(performance.now() - start),
      });
    }
  }
  return rows;
}
