# 持久任务阶段（1.4 开发线）

[English](durable-tasks.en.md)

TypeScript 宿主可从 `coremind-ai` 导入 `TaskSession` 和 `TaskDefinition`。本功能仍为未发布开发线；Python、Worker、sleep/wake 和嵌套调用另行交付。

```ts
import { TaskSession, type TaskDefinition } from "coremind-ai";

const task: TaskDefinition = {
  type: "counter",
  version: 1,
  initialPhase: "a",
  checkpointSchema: { type: "integer" },
  phases: {
    a: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1 }),
    b: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1, done: true }),
  },
};
const tasks = await TaskSession.open({ workspace: process.cwd(), sessionId: "demo", definitions: [task] });
try {
  if (!tasks.query("job")) await tasks.start({ taskId: "job", type: "counter", checkpoint: 0 });
  await tasks.resume("job");
  await tasks.resume("job");
  console.log(tasks.query("job"));
} finally {
  await tasks.close();
}
```

`start` 只保存初始状态，不执行处理器。每次 `resume` 执行一个阶段，下一阶段和检查点必须成功持久提交才可见。完成/取消的任务再次恢复只返回终态。通过 `cancel(taskId)` 中止活动阶段；取消不会撤销已发生的外部操作。同会话并发写操作被拒绝，不隐式排队。

阶段可返回 `documents` 和 `entries`，与检查点同一原子提交；document 须匹配 `open` 中注册的 documentSchemas。快照是副本。不能将内部 TaskCommitSession 与活动公共 TaskSession 同时打开，也不能用内部存储入口绕开公共执行合同。

## 迁移

定义结构、Schema 或阶段函数改变时增加 version，提供 `migrate(previous, signal)`，仅返回 `{ phase, checkpoint }`。同版本定义变化、降级、缺少迁移、异常、无效 Schema 结果均失败关闭。迁移失败保留原事实；成功迁移先原子保存新版本与状态，重启不重复迁移。完成/取消的任务不需要迁移。

处理器从持久阶段顶部重新执行；闭包变量、定时器和 JS 调用栈不会恢复。函数源码不能识别闭包或依赖模块行为变化，宿主须主动提升定义版本。迁移仅转换状态，不得直接执行工具或业务副作用。

## 使用模型与工具

在 `open` 中提供 `runtime: { config, configDir, authorityVersion, ... }`，处理器调用 `await context.run(prompt)`，读取标准 RunResult。可提供现有审批回调、工具定义、生命周期扩展、环境、maxSteps 和 stepTimeoutMs；不接受替代 RunStore、任意 runId 或 resumeRunId。工具/模型继续通过原 Runtime 权限、预算、Fact、取消与副作用门。原有 Runtime 超时不变，阶段沿用 stepTimeoutMs 默认 300000；预算按 Run 计算，不是全任务累计预算。

配置、权限和工具声明改变时不能借迁移恢复。`authorityVersion` 须随审批闭包、外部策略或凭据路由变化更新；恢复检查只保存身份哈希。宿主函数是可信代码，AbortSignal 无法强制终止任意 JavaScript/I/O，须协作取消并只从受治理入口启动业务调用。

若查询结果含 pendingRunId，原 Run 已进入需要核查的窗口；恢复会报 `task_run_unresolved`，不会重发。先保留任务目录与原 Run Facts，检查原 Run 的状态和副作用回执。本版本不提供清除该标识或自动结果协调；不要修改日志或新建替代 Run 绕过它。多次 keyed 调用与确定性复用属于 #365。

## 可复现验证

```text
npm run build
node examples/modules/recover-durable-runs/task-phases.mjs
npx vitest run packages/coremind-runtime/src/task-session.test.ts packages/coremind-runtime/src/task-session-process.test.ts packages/coremind-runtime/src/task-session-runtime.test.ts --maxWorkers=1
```

示例完全离线，演示 A→重开→B→完成，以及显式 v1→v2 状态迁移。真实进程退出由测试单独验证，普通 close/reopen 不代替崩溃验收。详见 [ADR 0026](../adr/0026-task-phases-and-migrations.md) 和[恢复 SOP](../modules/recover-durable-runs/SOP.zh-CN.md)。
