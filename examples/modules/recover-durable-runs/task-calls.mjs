import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskSession } from "coremind-ai";

const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-calls-"));
let executions = 0;
let pause = true;
let session;
const options = {
  workspace,
  sessionId: "example",
  runtime: {
    configDir: workspace,
    authorityVersion: "local-read-v1",
    env: { COREMIND_EXAMPLE_KEY: "test-only" },
    config: {
      schemaVersion: 2,
      name: "离线稳定键示例",
      defaultAgent: "main",
      provider: {
        id: "local-example",
        model: "unused",
        apiKeyEnv: "COREMIND_EXAMPLE_KEY",
        baseUrl: "http://127.0.0.1:1/v1",
      },
      agents: { main: {} },
      permissions: { mode: "assisted", workspaceOnly: true, network: "deny" },
      runtime: { maxToolCalls: 1, maxRetries: 0, runTimeoutMs: 5000 },
    },
    toolDefinitions: [
      {
        name: "lookup",
        description: "离线固定数据读取",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        effect: { operations: ["read"], reversible: true },
        execute: async ({ id }) => {
          executions += 1;
          return { text: `记录 ${id}`, details: { id } };
        },
      },
    ],
  },
  definitions: [
    {
      type: "lookup",
      version: 1,
      initialPhase: "read",
      checkpointSchema: { type: "string" },
      phases: {
        async read(context) {
          const text = await context.runCalls(async ({ executeTool }) => {
            const result = await executeTool("record", "lookup", { id: "42" });
            assert.deepEqual(await executeTool("record", "lookup", { id: "42" }), result);
            return result.content[0].text;
          });
          // 模拟结果已保存、阶段尚未提交；真实进程退出由单独测试覆盖。
          if (pause) throw new Error("阶段提交前暂停");
          return { phase: "read", checkpoint: text, done: true };
        },
      },
    },
  ],
};
try {
  session = await TaskSession.open(options);
  await session.start({ taskId: "job", type: "lookup", checkpoint: "initial" });
  await assert.rejects(session.resume("job"), /阶段提交前暂停/u);
  const recorded = session.calls("job");
  await session.close();
  pause = false;
  session = await TaskSession.open(options);
  assert.equal((await session.resume("job")).status, "completed");
  assert.deepEqual(session.calls("job"), recorded);
  assert.equal(executions, 1);
  console.log("Keyed calls and durable reuse OK");
} finally {
  await session?.close();
  await rm(workspace, { recursive: true, force: true });
}
