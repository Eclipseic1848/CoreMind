import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// 仅供测试：宿主启动参数选择包入口，不接受 RPC 传来的模块路径或源码。
const [workspace, bundle] = process.argv.slice(2);
// 仅记录测试宿主加载阶段，失败时复用客户端已有 stderr 缓冲。
console.error(`task-session-host: import-start uptime=${process.uptime()}`);
const { runStdioWorker } = await import(bundle ? pathToFileURL(bundle).href : "coremind-worker");
console.error(`task-session-host: import-ready uptime=${process.uptime()}`);
await runStdioWorker(process.stdin, process.stdout, {
  tasks: {
    runtime: {
      authorityVersion: "cross-language-fixture-v1",
      env: { COREMIND_TASK_TEST_KEY: "offline-test-only" },
      approveTool: async () => "allow",
      toolDefinitions: [
        {
          name: "probe",
          description: "记录一次本地效果以验证已提交结果复用",
          parameters: { type: "object", additionalProperties: false },
          effect: { operations: ["external"], reversible: false },
          execute: async (_args, context) => {
            appendFileSync(path.join(workspace, "effects.txt"), `${context.callId}\n`, "utf8");
            return { text: "已保存🙂", details: { value: 42 } };
          },
        },
      ],
    },
    definitions: [
      {
        type: "wait",
        version: 1,
        initialPhase: "a",
        checkpointSchema: { type: "integer", minimum: 0 },
        phases: {
          a: ({ task }) => ({
            phase: "b",
            checkpoint: task.checkpoint,
            sleepUntil: task.checkpoint,
          }),
          b: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint, done: true }),
        },
      },
      {
        type: "counter",
        version: 1,
        initialPhase: "a",
        checkpointSchema: { type: "string" },
        phases: {
          a: async (ctx) => {
            const text = await ctx.runCalls(async ({ executeTool }) => {
              const result = await executeTool("one", "probe", {});
              return result.content[0].text;
            });
            // 真实退出发生在 Run 结果已落盘、任务阶段尚未提交的窗口。
            const marker = path.join(workspace, "crashed.txt");
            if (!existsSync(marker)) {
              writeFileSync(marker, "run-result-committed", "utf8");
              process.exit(23);
            }
            return { phase: "b", checkpoint: text, sleepUntil: 0 };
          },
          b: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint, done: true }),
        },
      },
      {
        type: "blocking",
        version: 1,
        initialPhase: "a",
        checkpointSchema: { type: "null" },
        phases: {
          a: async ({ signal }) => {
            writeFileSync(path.join(workspace, "entered.txt"), "entered", "utf8");
            signal.throwIfAborted();
            await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
      },
    ],
  },
});
