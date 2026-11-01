# 持久运行与故障恢复 SOP

## 一、执行前确认

1. 记录工作目录、配置文件、配置指纹、运行入口和权限模式。
2. 判断工具副作用属于文件、进程、网络还是外部系统，并写明是否可回退、是否可安全重试。
3. 确认业务系统是否提供幂等键或事务号；没有时不得承诺自动重放安全。
4. 对旧 Session 先复制验收样本，不直接拿唯一原件试验。

## 二、运行状态

1. 接收任务时创建 `runId`、`operationId`、`correlationId` 与 `ACCEPT` 记录。
2. 执行前迁移到 `running`。
3. 审批拒绝或需要人工决定时迁移到 `paused`，记录稳定 `finishReason`。
4. 收到中止时先迁移到 `aborting`，清理结束后以 `failed` 和 `aborted` 原因收口。
5. 只有完整验证通过时进入 `completed`；异常、超时与预算超限进入 `failed`。
6. 终态迁移后生成 `RunResult.snapshot`；四个入口只能序列化和校验这份快照，不能自行推导另一套状态。

## 三、工具与副作用

1. 工具调用分配 `callId`，由 run、step 和 call 生成 `idempotencyKey`。
2. 写操作执行前创建 Checkpoint；不可回退的命令也要留下不可逆记录。
3. 审批或策略拒绝发生在执行前时写 `not_started`；只有批准并即将执行时才写 `started`。
4. 明确成功后写 `committed`；已开始但结果不确定时写 `unknown`。
5. 恢复时：`not_started` 可重新决策；稳定完成步骤中的 `committed` 跳过；未完成步骤的 `committed`、`started` 或 `unknown` 停止并请求人工判断。

## 四、Session 迁移

1. 校验旧文件头、session id、JSON 行和受支持条目类型。
2. 在同目录生成 `<id>.jsonl.v3.backup`，逐字节比对。
3. 在版本化仓库写入未完成迁移标记。
4. 把条目转换到新 schema，使用临时文件与原子 rename 提交。
5. 重新打开目标并校验完成标记及上下文。
6. 最后切换稳定公开路径；此前任何失败都不得覆盖旧文件。
7. 重复执行一次，确认不会重复消息或创建第二份权威会话。

## 五、崩溃与恢复判断

| 现场 | 动作 |
|---|---|
| 只有未完成 JSONL 尾行，前面记录完整 | 自动裁掉尾行并原子重写 |
| 整文件无法解析、字段非法、sequence 断裂或落盘顺序乱序 | 失败关闭，从备份或人工证据恢复；只有完整记录后的 JSON 语法截断尾部可自动修复 |
| `.lock` 存在且 writer 仍在 | 等待，不删除锁 |
| `.lock` 存在且已证明 writer 不存在 | 备份锁和数据后人工移除锁，再重试 |
| operation 已 completed/failed | 不允许 resume，创建新任务 |
| 副作用结果未知 | 查询外部系统；不能确认时保持暂停 |

## 六、显式任务会话

1. 按 [TaskCommit 合同](GUIDE.zh-CN.md)固定工作区、sessionId 和 document Schema；这是独立任务事实，不是普通 Run 的 resume。
2. 用稳定 commitId 和读取到的 revision 提交完整 checkpoint/document/entry。收到成功回执后才消费新投影。
3. 冲突先核对内容与 revision。持久回执失败或 I/O 结果未知时关闭 holder，再重开并以相同内容/commitId核对；禁止直接更换键重做外部效果。
4. 活 writer 拒绝竞争；只有原租约机制确认进程不存在才回收死主。锁无法确认时保留现场，不通过增大超时或删锁继续。
5. 默认任务日志尾部损坏也失败关闭，不套用上表的普通 Run 尾部修复。未知 Schema/版本或工作区身份变化须保留原文件并人工核查。
6. 运行下面的无模型示例与跨进程测试；Windows 本地通过不能替代 Linux CI。旧 Run/Session/request-rebuild 回归与全部原发布门仍须通过。

```powershell
npm run build
node examples/modules/recover-durable-runs/task-commit.mjs
npx vitest run --project coremind-runtime packages/coremind-runtime/src/task-commit.test.ts packages/coremind-runtime/src/task-commit-crash.test.ts --maxWorkers=1
```

## 七、验证命令

```powershell
npx vitest run packages/coremind-runtime/src/invariant-checker.test.ts packages/coremind-runtime/src/operation-state.test.ts packages/coremind-runtime/src/run-state.test.ts packages/coremind-runtime/src/session-conformance.test.ts packages/coremind-runtime/src/session.test.ts packages/coremind-runtime/src/checkpoint.test.ts packages/coremind-runtime/src/snapshot.test.ts packages/coremind-runtime/src/runtime.test.ts packages/coremind-worker/src/server.test.ts --maxWorkers=1
npm run check:modules
```

检查器的 `gate` 档必须遍历仓库内受跟踪的确定性 fixture，并对 I-1～I-12 输出零 violation；`eval` 档必须可独立运行。Linux 使用同一命令。真实进程崩溃、并发 writer 与文件系统 rename 行为必须分别在 Windows 和 Linux 验收，不能互相替代。

## 公共任务执行与迁移验收

1. 核对 type/version/Schema、authorityVersion 与 Runtime 配置；确认处理器从顶部重进不会直接重复业务副作用。
2. 从 query 获取 taskId、phase、status、checkpoint 和 pendingRunId。已有未提交 Run 时保全其 Facts 与回执，不改日志或创建替代 Run。
3. 定义变化必须提升版本并提供仅转换状态的 migrate；权限/预算/工具变化不允许借迁移扩权。失败时比较原日志，确认未写迁移事实。
4. 运行 task-session.test.ts、task-session-process.test.ts、task-session-runtime.test.ts 与 task-phases.mjs 示例；确认真实进程重启、终态不重复、取消/超时和权限/预算/未知效果边界。
5. 执行原模块及仓库门禁；Windows 本地通过不能替代 Linux CI。未合并且安全门受阻时保持 Issue 开放，不发布。

完整 API 与边界见[任务指南](../../guides/durable-tasks.zh-CN.md)。

## 持久等待验收

1. 保存 taskId、sleepId、wakeAt；确认下一阶段、结果与等待一并提交。未确认提交不得向调用方宣称已睡眠。
2. 重启时 query 已知任务并处理 ready，再用 nextWake 重建 alarm。timer 单次最多 2147483647 毫秒，触发后重新核对期限；不持有旧 Promise 等待恢复。
3. wakeId 在该任务内保持稳定，载荷绑定 sleepId。not_due 未占用键；accepted 才显式 resume。duplicate/stale/terminal 不驱动阶段；I/O 结果未知先关闭重开核对原键。
4. 运行 task-sleep.test.ts、task-sleep-process.test.ts、task-session-runtime.test.ts 和 task-sleep.mjs。检查真实进程退出、到期前/恰好/之后、取消竞争与确认丢失。
5. 保留所有原执行和验收超时；Windows 与 Linux CI 均须通过才合并关闭。回滚须停止 writer 并保全任务目录，旧阶段 SDK 不支持新的睡眠/唤醒记录。
