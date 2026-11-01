# 持久运行与故障恢复

状态：保留既有 Run 恢复合同，新增 1.4 开发线的 internal TaskCommit 存储基础；不是已发布版本声明。支持平台：Windows、Linux，须分别验收。macOS 尚未列为正式支持。

## 目的

这个模块让一次智能体运行拥有可恢复、可审计且不会伪造成功的外围状态。它不复制 Workflow 或 Loop 的业务阶段，而是用一个 durable operation 回答：任务是否已接收、正在运行、暂停、正在中止、完成或失败。

## 四类状态的唯一所有者

| 状态 | 权威所有者 | 不能承担的职责 |
|---|---|---|
| 对话与压缩视图 | Session | 不判断运行是否完成 |
| 运行生命周期与 Trace | DurableOperation + RunState | 不保存完整工具大输出 |
| 文件与外部副作用 | Checkpoint + Effect Receipt | 不替代业务系统自己的事务记录 |
| token、成本与预算 | RunBudget + RunMetrics | 不推断 Provider 未返回的数据 |

LoopController 继续管理 planning、execute、verify、repair 等业务阶段；它不会被第二套平行 Loop 取代。

## 公共合同

- `RunResult.operation`：CLI、TUI、TypeScript SDK 与 Python SDK 共享的 operation 权威快照。
- `RunResult.snapshot`：四个入口共享的纯 JSON 终态信封，统一 operation、outcome、指标、评测、Trace、Checkpoint、Artifact、扩展收据和恢复判断。
- `DurableOperation`：合法迁移、重复事件幂等和恢复校验。
- `FileRunStore`：单 writer 锁、连续序号、ordinary 逐 Fact 追加、critical 原子同步和可控尾部修复。
- `prepareRunResume()`：恢复前检查配置指纹、终态、稳定步骤和 Effect Receipt。
- `CoreMindSession`：稳定公开路径、双后端合同与旧 schema 迁移。

## 显式任务提交（internal）

`TaskCommitSession` 把一个任务 checkpoint、typed document 更新和文本 entry 放在一个 critical 原子记录中，先验证、持久提交，再整体发布投影。全会话 revision、commitId 内容幂等和长期 writer 租约避免静默覆盖。原子任务日志是唯一权威，旧 Session/Run/Workspace 数据不迁移、不重复写入。

本项不执行任务或提供 sleep/wake、嵌套调用、公共 SDK/Worker 接入。内置存储只承诺 `process_crash`；未知 I/O 结果须重开核对原提交，不推断远端业务副作用。详见[合同与错误处理](GUIDE.zh-CN.md)、[ADR](../../adr/0025-explicit-task-commit-authority.md)和[可运行示例](../../../examples/modules/recover-durable-runs/README.zh-CN.md)。

## 稳定不变量

- operation 只能沿合法边迁移；终态不能继续运行。
- 相同 `eventId` 不会重复产生状态变化。
- 已提交副作用只有在所属步骤稳定完成时才会随步骤跳过；归属不确定时必须人工判断。
- Checkpoint、工具调用和 Effect Receipt 使用同一个幂等关联键。
- RunState 必须按实际落盘顺序保持连续；读取与恢复不会通过重新排序掩盖乱序，竞争 writer 也不会静默覆盖。
- 审批或策略拒绝发生在工具执行前时记录 `not_started`，可安全重新决策；只有真实进入执行后才记录 `started`。
- 只修复“已有完整记录 + 最后一行未写完”的 JSONL 尾部；整文件损坏失败关闭。
- 旧 Session 在迁移前生成 `.v3.backup`；迁移失败时公开原文件保持不变。

## 0.3.1 候选：关联不变量检查器

`checkInvariantFacts(facts, { mode })` 是 Runtime 内部的只读检查缝隙，不修改任何事实，也不改变公共 SDK 导出面。生产默认 `off`；`eval` 返回调试诊断；`gate` 供发布验收使用。I-1～I-12 是稳定违规码，不是新增的公共 `CoreMindError` 错误码。

| 违规码 | 检查内容 |
|---|---|
| I-1 | RunState journal sequence 连续无洞 |
| I-2 | 同 sequence 同内容幂等，异内容冲突 |
| I-3 | finish 后无新记录 |
| I-4 | 新格式 StepId 在 Run 内唯一；0.3.0 的 `loop-execute` 显式降级 |
| I-5 | Run、Session、Turn 与 Call 关联一致；旧记录缺少 TurnId 时跳过 Turn 级判断 |
| I-6 | ReceiptId 回溯到同一 Run、Step 与 Call |
| I-7 | 每个工具 Call 恰有一个可解释终结；aborted/timeout Run 显式关闭在飞 Call |
| I-8 | Checkpoint 回溯到同一 Run、Operation、Call 与 Receipt |
| I-9 | `approval_required` / `approval_resolved` 按 ApprovalId 一一配对 |
| I-10 | Abort 分界点后无不被准入规则允许的迟到终态事实 |
| I-11 | Operation 链以 ACCEPT 开始、sequence 连续且迁移合法 |
| I-12 | Effect Receipt 状态只沿合法方向迁移且不回退 |

## 平台边界

Windows 与 Linux 使用相同的合同和测试定义。锁文件在异常进程退出后不会被自动猜测删除：确认没有 writer 后，由操作者按 [恢复 SOP](SOP.zh-CN.md) 处理。真实跨进程崩溃仍必须在目标平台人工验收。

## 源码与证据

- [operation 状态机](../../../packages/coremind-runtime/src/operation-state.ts)
- [RunState](../../../packages/coremind-runtime/src/run-state.ts)
- [关联不变量检查器](../../../packages/coremind-runtime/src/invariant-checker.ts)
- [运行快照](../../../packages/coremind-runtime/src/snapshot.ts)
- [Session Adapter](../../../packages/coremind-runtime/src/session.ts)
- [双后端合同测试](../../../packages/coremind-runtime/src/session-conformance.test.ts)
- [故障恢复示例](../../../examples/modules/recover-durable-runs/README.zh-CN.md)
- [可复用 Skill](../../../skills/recover-durable-runs/SKILL.md)

该模块只能证明框架恢复合同成立，不能代替业务数据库、支付系统或其他外部服务的幂等与补偿设计。

## 公共持久任务阶段（1.4 开发线）

`coremind-ai` 的 `TaskSession` 在上述存储基础上提供 start/query/resume/cancel 与显式版本迁移。每次 resume 执行一个阶段，模型/工具使用既有 Runtime；有 pendingRunId 时先保全原 Run，不自动重发。详见[公共任务指南](../../guides/durable-tasks.zh-CN.md)与 [ADR 0026](../../adr/0026-task-phases-and-migrations.md)。此开发线不代表正式发布；跨语言入口另行交付；显式稳定键调用见下文。

## 持久等待（1.4 开发线）

阶段返回 sleepUntil 原子保存下一阶段与绝对期限；nextWake 查询最近持久等待，wake(taskId, wakeId, sleepId) 幂等置为 ready，再显式 resume。旧 alarm 不得推进新睡眠；宿主负责重启、恢复已知 ready 任务和重建计时器。取消使 alarm 失效，关闭空闲会话保留等待。等待不延长 Run、工具、阶段或 Worker 超时。用法、回执丢失处理和旧 SDK 回滚限制见[任务指南](../../guides/durable-tasks.zh-CN.md)与 [ADR 0027](../../adr/0027-durable-task-sleep-wake.md)。

## 稳定键调用（1.4 开发线）

runCalls 内 executeTool 的稳定键绑定参数、权限身份与顺序，一个阶段共享原 Run 的预算/权限/ChildRun 上限。calls 查询历史结果；未知外部效果仍暂停，已提交结果可从原 Run 协调。父任务终态不执行，历史受原 1 MiB 限制，不自动清理。兼容、回滚和宿主版本责任见 [任务指南](../../guides/durable-tasks.zh-CN.md) 和 [ADR 0028](../../adr/0028-keyed-task-calls.md)。

## 跨语言入口

任务与会话分支的 Protocol v2 / 同步与异步 Python 入口已接入同一 Node Runtime。使用方法和权限边界见 [跨语言指南](../embed-coremind-python/GUIDE.zh-CN.md)
