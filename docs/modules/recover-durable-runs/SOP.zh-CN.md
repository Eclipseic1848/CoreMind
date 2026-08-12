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
3. 发起工具时写 `started` Effect Receipt。
4. 明确成功后写 `committed`；结果不确定时写 `unknown`。
5. 恢复时：稳定完成步骤中的 `committed` 跳过；未完成步骤的 `committed` 或任何 `unknown` 停止并请求人工判断。

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
| 整文件无法解析或 sequence 断裂 | 失败关闭，从备份或人工证据恢复 |
| `.lock` 存在且 writer 仍在 | 等待，不删除锁 |
| `.lock` 存在且已证明 writer 不存在 | 备份锁和数据后人工移除锁，再重试 |
| operation 已 completed/failed | 不允许 resume，创建新任务 |
| 副作用结果未知 | 查询外部系统；不能确认时保持暂停 |

## 六、验证命令

```powershell
npx vitest run packages/coremind-runtime/src/operation-state.test.ts packages/coremind-runtime/src/run-state.test.ts packages/coremind-runtime/src/session-conformance.test.ts packages/coremind-runtime/src/session.test.ts packages/coremind-runtime/src/checkpoint.test.ts packages/coremind-runtime/src/snapshot.test.ts packages/coremind-runtime/src/runtime.test.ts packages/coremind-worker/src/server.test.ts --maxWorkers=1
npm run check:modules
```

Linux 使用同一命令。真实进程崩溃、并发 writer 与文件系统 rename 行为必须分别在 Windows 和 Linux 验收，不能互相替代。
