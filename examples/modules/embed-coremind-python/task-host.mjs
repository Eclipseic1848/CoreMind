import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { runStdioWorker } from "coremind-worker";

// 两种语言复用同一定义；计数文件仅验证工具执行次数，不存放恢复状态。
export function taskExample(workspace) {
  return {
    runtime: {
      authorityVersion: "task-example-v1",
      approveTool: async ({ tool, args }) =>
        tool === "record" && args.path === "canary.txt" ? "allow" : "deny",
      toolDefinitions: [
        {
          name: "record",
          description: "保存一次示例执行记录并返回阶段结果",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", const: "canary.txt" },
              value: { type: "integer" },
            },
            required: ["path", "value"],
            additionalProperties: false,
          },
          effect: { operations: ["write"], reversible: true, pathFields: ["path"] },
          execute: async ({ path: relative, value }, context) => {
            appendFileSync(
              path.join(workspace, relative),
              `${process.pid}:${context.callId}\n`,
              "utf8",
            );
            return { text: "阶段 A 的已保存结果", details: { value } };
          },
        },
      ],
    },
    definitions: [
      {
        type: "example",
        version: 1,
        initialPhase: "a",
        checkpointSchema: { type: "integer" },
        phases: {
          a: async (context) => {
            const value = await context.runCalls(async ({ executeTool }) => {
              const args = { path: "canary.txt", value: context.task.checkpoint + 1 };
              const saved = await executeTool("record", "record", args);
              assert.deepEqual(await executeTool("record", "record", args), saved);
              return saved.details.value;
            });
            return { phase: "b", checkpoint: value, sleepUntil: 0 };
          },
          // B 只消费已提交结果，不跨阶段重新调用 A 的稳定键。
          b: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint + 1, done: true }),
        },
      },
    ],
  };
}

// 宿主参数不是 RPC 输入；省略目录时兼容 wheel 冒烟的工作目录。
if (import.meta.main) {
  const workspace = path.resolve(process.argv[2] ?? process.cwd());
  appendFileSync(path.join(workspace, "worker-pids.txt"), `${process.pid}\n`, "utf8");
  await runStdioWorker(process.stdin, process.stdout, { tasks: taskExample(workspace) });
}
