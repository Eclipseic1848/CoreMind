# 持久任务阶段（1.4 开发线）

[English](durable-tasks.en.md)

TypeScript 宿主可从 `coremind-ai` 导入 `TaskSession` 和 `TaskDefinition`。本功能仍为未发布开发线；Python/Worker 入口另行交付；显式稳定键调用见下文。

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

## 持久等待与宿主唤醒

阶段返回 `{ phase: "b", checkpoint: result, sleepUntil: deadline }` 时，将下一阶段、结果、可选 document/entry 与睡眠状态一起提交。`deadline` 是非负整数 UTC epoch 毫秒，最大 `8_640_000_000_000_000`；过去期限允许立即唤醒，不能同时返回 `done: true`。查询得到 `status: "sleeping"` 和 `sleep: { sleepId, wakeAt }`。每次睡眠生成独立 sleepId，即使期限相同，旧 alarm 也不能唤醒下一次睡眠。

`nextWake()` 返回最早等待的 `{ taskId, sleepId, wakeAt, remainingMs }`，同期限按 taskId 排序，无等待时返回 undefined。它从持久状态和当前时钟重算剩余时间，不恢复旧 Promise/timer。默认使用 Date.now；测试可注入受信任的 `clock`，不会改变 Runtime、工具、阶段或 Worker 的超时。时钟回拨会增加剩余等待，到期判断仍以绝对期限为准。

宿主保留 taskId、sleepId 和稳定 wakeId，调用 `wake(taskId, wakeId, sleepId)`。它只持久置为 ready，不执行下一阶段；随后显式 `resume(taskId)`。直接 resume 也会检查期限：早到保持 sleeping，到期先提交 ready，再运行下一阶段。等待期间没有活动 Run 或阶段计时器，等待长度不会扩大任何原执行超时。

| wake 结果 | 宿主动作 |
|---|---|
| `accepted` | 已将 ready 与 wakeId→sleepId 一起持久提交，可显式 resume |
| `duplicate` | 此 taskId 下相同 wakeId/sleepId 已准入；不重复写入，不把旧 alarm 当作当前阶段指令 |
| `not_due` | 未到期，未写入或占用 wakeId；重新查询期限，到期可用原键重试 |
| `stale` | 不是当前睡眠；丢弃旧通知，不推进阶段 |
| `terminal` | 已完成或取消；丢弃通知，不复活任务 |

已接受的 wakeId 改绑其他 sleepId 报 `task_wake_conflict`。两个标识均须以字母/数字开头，只含字母、数字、下划线、连字符，最长128字符。并发写返回 task_busy；原操作落定后核对状态和原键。已准入键保留在任务状态中，仍受单次 TaskCommit 1 MiB 限制，不承诺无限唤醒历史。写入确认失败时关闭并重开，再核对原键；不能假设失败即回滚。

宿主负责进程启动、alarm 投递和 ready 任务恢复。如果 wake 已落盘但进程在 resume 前退出，新进程应先 query 已知任务，再显式恢复 ready；仅扫描 nextWake 不会发现它。`cancel` 使等待任务终止，后续 alarm 无效；`close` 空闲会话仅释放租约，不取消已提交等待。到期前不执行迁移；定义升级须通过 resume 显式迁移，wake 不替代迁移或授予新权限。

完整离线宿主示例：`node examples/modules/recover-durable-runs/task-sleep.mjs`。示例重开会话后使用普通 setTimeout，单次最多 `2_147_483_647` ms，醒来重新校验期限；框架没有新增后台调度服务。普通 close/reopen 不代替真实进程退出测试。

兼容：旧无睡眠状态可直接读取；新 `sleeping` 状态需要更新穷尽分支。旧阶段 SDK 会拒绝包含 sleep/wakes 的新状态，因此回滚前停止 writer 并备份任务目录，不编辑事实或用旧 SDK 强行继续。此增量不改变 Protocol v2、Python/Worker 任务入口或旧 Run/Session 数据。详见 [ADR 0027](../adr/0027-durable-task-sleep-wake.md)。

## 迁移

定义结构、Schema 或阶段函数改变时增加 version，提供 `migrate(previous, signal)`，仅返回 `{ phase, checkpoint }`。同版本定义变化、降级、缺少迁移、异常、无效 Schema 结果均失败关闭。迁移失败保留原事实；成功迁移先原子保存新版本与状态，重启不重复迁移。完成/取消的任务不需要迁移。

处理器从持久阶段顶部重新执行；闭包变量、定时器和 JS 调用栈不会恢复。函数源码不能识别闭包或依赖模块行为变化，宿主须主动提升定义版本。迁移仅转换状态，不得直接执行工具或业务副作用。

## 使用模型与工具

在 `open` 中提供 `runtime: { config, configDir, authorityVersion, ... }`，处理器调用 `await context.run(prompt)`，读取标准 RunResult。可提供现有审批回调、工具定义、生命周期扩展、环境、maxSteps 和 stepTimeoutMs；不接受替代 RunStore、任意 runId 或 resumeRunId。工具/模型继续通过原 Runtime 权限、预算、Fact、取消与副作用门。原有 Runtime 超时不变，阶段沿用 stepTimeoutMs 默认 300000；预算按 Run 计算，不是全任务累计预算。

配置、权限和工具声明改变时不能借迁移恢复。`authorityVersion` 须随审批闭包、外部策略或凭据路由变化更新；恢复检查只保存身份哈希。宿主函数是可信代码，AbortSignal 无法强制终止任意 JavaScript/I/O，须协作取消并只从受治理入口启动业务调用。

传统 context.run 的 pendingRunId 仍要求先核对原 Run，不自动重发。下述显式 runCalls 仅在稳定键及原副作用证明满足时协调原 Run；不要删除标识或新建替代 Run。

## 可复现验证

```text
npm run build
node examples/modules/recover-durable-runs/task-phases.mjs
node examples/modules/recover-durable-runs/task-sleep.mjs
npx vitest run packages/coremind-runtime/src/task-session.test.ts packages/coremind-runtime/src/task-session-process.test.ts packages/coremind-runtime/src/task-session-runtime.test.ts --maxWorkers=1
npx vitest run packages/coremind-runtime/src/task-sleep.test.ts packages/coremind-runtime/src/task-sleep-process.test.ts --maxWorkers=1
```

示例完全离线，演示 A→重开→B→完成，以及显式 v1→v2 状态迁移。真实进程退出由测试单独验证，普通 close/reopen 不代替崩溃验收。详见 [ADR 0026](../adr/0026-task-phases-and-migrations.md) 和[恢复 SOP](../modules/recover-durable-runs/SOP.zh-CN.md)。

## 稳定键调用（1.4 开发线）

一个阶段在 `context.run(prompt)` 与 `context.runCalls(handler)` 中二选一，最多拥有一个 Run。后者精确执行已注册工具，不发起父模型请求，也不能替代配置中的 workflow/loop。所有键共享原 Run 的工具/步骤/token/费用预算、权限、审批、取消、超时和 ChildRun 上限。

```ts
const result = await context.runCalls(async ({ executeTool }) => {
  const first = await executeTool("record", "lookup", { id: "42" });
  const same = await executeTool("record", "lookup", { id: "42" });
  return same.details;
});
```

`lookup` 须在 Runtime 中显式注册，示例见 `examples/modules/recover-durable-runs/task-calls.mjs`。已有固定目标的委派使用 `executeTool("child", "delegate", { target, task, references: [] })`，仍由原 ChildRun Coordinator 准入。每个不同键须串行 await；重复在飞键连接原 Promise，已完成键返回持久结果的副本。返回值为 `{ content, details }`，须为有限 JSON；不支持保存函数、循环引用、无限值或被原脱敏门识别的凭据。大输出仍受既有任务提交 1 MiB 上限，应引用受治理 Artifact。

作用域包括父任务、阶段、定义版本和本次阶段 Run。循环回同名阶段会获得新 Run，不复用旧一轮结果。签名绑定规范化参数、工具以及完整 Runtime 权限/能力身份；恢复还核对唯一键出现顺序。换工具、换参数、遗漏/插入/调换旧键、同版本改处理器或能力变化均拒绝；调用分歧随 TaskCommit 保存审计。修改闭包、外部服务能力、依赖行为或凭据路由时，宿主仍必须更新定义版本/authorityVersion，源码哈希不能发现这些变化。

`session.calls(taskId)` 查询全部历史调用的 key、工具、参数、作用域、stepId、RunId、状态和已提交结果；失败记录仅存稳定错误标记，详情查原 Run Facts。父任务完成/取消后不再执行，记录继续保留；没有自动清理、无限历史或新的归档服务。

恢复顺序：先保存调用 intent；原 Runtime 完成生命周期与回执校验后 critical 保存整步结果；再提交任务结果账本，最后才交给处理器。真实进程在结果两次提交之间退出时，从同一 Run 的整步结果重建，不重做工具。Run 已成功而阶段未提交时仅重进处理器并复用旧键，不准新增键。原 Run 未结束时沿用原恢复判定：未知外部效果暂停；符合既有幂等证明条件时新 Call/attempt 关联旧 receipt，旧收据不可改写。失败/取消调用不能换键或新 Run 绕过；不支持迁移未解决的旧 Run。

发生写入确认故障时，旧 holder 不再可用：保留目录，关闭重开，查原 TaskCommit 与 Run；不假定回滚或自动继续。任意宿主 JS、时间、随机值、裸网络请求不会被重放保护；这不是外部 exactly-once、持久 JS 栈或新的任务执行引擎。

旧任务无 callGroups 时仍可读；旧 SDK 会拒绝新账本字段，且不认识任务专用 Run 标记。回滚前停止所有 writer，保全任务与 Run 两个事实域；不要用旧 SDK 单独 resume 新任务 Run。Python/Worker 入口属于后续 #367，本项不改变协议。正式能力仍须双平台 CI、安全门和合并验收。

验证：运行 `task-calls.test.ts`、`task-calls-process.test.ts`、`task-calls-child.test.ts` 和离线 `task-calls.mjs`，再运行模块原门禁。包含真实进程在 intent、效果、整步结果、任务结果、Run 结束后的退出，及 ChildRun、预算、权限、取消、写入确认故障。详见 [ADR 0028](../adr/0028-keyed-task-calls.md)。
