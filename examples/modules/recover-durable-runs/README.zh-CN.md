# 持久运行与故障恢复示例

## 目标

验证“暂停后继续”和“已提交副作用不重放”，而不是制造一个新的业务 Loop。

## 步骤

以下是已配置写入工具和人工审批的业务项目中的操作片段；本示例目录没有独立的 `coremind.yaml`，不能在此直接运行。

```powershell
coremind run coremind.yaml --prompt "把验收文字写入 result.md" --json-events
```

1. 在写入审批出现时按 `n`，确认 `snapshot.outcome.status=paused` 且 `snapshot.operation.state=paused`。
2. 记录最后一行的 `runId`。
3. 使用下列命令继续：

```powershell
coremind run coremind.yaml --resume <runId> --json-events
```

4. 批准写入后，确认只有一个 Checkpoint、一个 committed Effect Receipt 和一个目标文件变化。
5. 再次用同一 `runId` 恢复，确认终态 operation 被拒绝继续，而不是再次写入。
6. 比对顶层兼容字段与 `snapshot`，确认 `runId`、operation、outcome、指标和证据一致。

## 无模型 TaskCommit 示例（1.4 发布线）

仓库安装依赖并构建后，从根目录运行：

```powershell
npm run build
node examples/modules/recover-durable-runs/task-commit.mjs
```

[示例源码](task-commit.mjs)在独立临时工作区原子保存 checkpoint/document/文本 entry，关闭重开验证重建，再检查同 commitId 幂等和异内容冲突。成功输出 `TaskCommit OK`，最后仅清理本次临时目录；不读取凭据、不调用模型、不访问外部业务系统。

这是 `coremind-runtime/internal` 存储合同示例，不执行任务阶段或提供 sleep/wake。真实进程退出窗口见 `task-commit-crash.test.ts`；示例中的正常 close/reopen 不代替崩溃验收。

## 故障注入

从仓库根目录运行：

```powershell
npx vitest run packages/coremind-runtime/src/invariant-checker.test.ts packages/coremind-runtime/src/operation-state.test.ts packages/coremind-runtime/src/run-state.test.ts packages/coremind-runtime/src/session.test.ts packages/coremind-runtime/src/snapshot.test.ts packages/coremind-worker/src/server.test.ts --maxWorkers=1
```

检查器测试会在 `gate` 档遍历受 Git 跟踪的当前格式与 0.3.0 fixture；不要用本机 `.coremind` 目录替代验收输入。

返回 [中文指南](../../../docs/modules/recover-durable-runs/GUIDE.zh-CN.md)。

## 离线任务阶段与迁移示例

构建后执行 `node examples/modules/recover-durable-runs/task-phases.mjs`。示例从公共 coremind-ai 导入 TaskSession，验证 A→重开→B→完成和显式 v1→v2 迁移，不读取凭据或调用模型。输出 `Task phases and migration OK`，仅清理自身临时工作区。真实进程退出由 task-session-process.test.ts 单独验收。

参见[任务指南](../../../docs/guides/durable-tasks.zh-CN.md)。

## 离线持久等待与宿主 alarm 示例

构建后执行 `node examples/modules/recover-durable-runs/task-sleep.mjs`。示例提交 A 的结果和期限，重开后从 nextWake 建立有上限的普通 timer，再 wake/resume 执行 B，输出 `Durable sleep and host alarm OK`。无需凭据，仅清理自身临时目录。宿主实际重启还须 query 已知 ready 任务；此示例的 close/reopen 不代替 task-sleep-process.test.ts 的真实进程退出验证。

## 稳定键调用（1.4 发布线）

构建后运行 `node examples/modules/recover-durable-runs/task-calls.mjs`。验证重复键和结果提交后重开，真实工具计数仅1；使用固定假凭据且不请求模型，输出 `Keyed calls and durable reuse OK`。仅清理自身临时目录。真实进程退出另由 task-calls-process.test.ts 验证。

## 真实进程重启组合示例

构建后执行 `node examples/modules/recover-durable-runs/task-restart.mjs`。阶段 A 原子保存稳定调用结果与等待，父宿主确认子进程退出后启动新进程，按持久期限显式唤醒；阶段 B 消费已保存结果。示例核对进程身份不同、原 Run/key/result 保持、执行记录仅一条；不使用真实 Provider，不改变原子进程限时。

这是离线受控窗口验证，不保证任意外部系统 exactly-once。Python 对应示例见[同步/异步任务](../embed-coremind-python/tasks.py)。
