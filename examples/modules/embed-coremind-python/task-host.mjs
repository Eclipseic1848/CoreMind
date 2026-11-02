import { runStdioWorker } from "coremind-worker";

// 宿主部署时显式注册可信定义；Python 只传类型标识和 JSON 检查点。
await runStdioWorker(process.stdin, process.stdout, {
  tasks: {
    definitions: [
      {
        type: "example",
        version: 1,
        initialPhase: "a",
        checkpointSchema: { type: "integer" },
        phases: {
          a: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint + 1, sleepUntil: 0 }),
          b: ({ task }) => ({ phase: "b", checkpoint: task.checkpoint + 1, done: true }),
        },
      },
    ],
  },
});
