# 持久运行与故障恢复上手指南

## 什么时候需要

当任务会写文件、运行命令、跨多轮验证，或用户希望在审批拒绝、终端关闭、网络中断后继续时，应启用本模块的恢复合同。纯一次性只读问答仍会产生 operation，但通常不需要手工 resume。

## 查看权威结果

```powershell
coremind run coremind.yaml --prompt "执行任务" --json-events
```

最后一条 `run_result.snapshot` 是权威纯 JSON 结果，统一包含 `runId`、`operation`、`outcome`、指标、评测、Trace、Checkpoint、Artifact、扩展收据和恢复判断。顶层兼容字段必须与快照一致；不要只根据自然语言总结判断成功。

## 验证关联不变量

Runtime 内部的 `checkInvariantFacts(facts, { mode })` 只读检查 Run、Session 与 Checkpoint 事实。生产默认 `off`；调试或评估使用 `eval`；发布验收使用 `gate`。Gate fixture 必须存放在受 Git 跟踪的 `packages/coremind-runtime/test-fixtures/invariant-checker/`，不能读取运行测试时生成的 `.coremind` 文件。

0.3.0 旧事实没有 TurnId，检查器按事实发生时的已知关联降级；同一 Run 在 0.3.1 Resume 后产生的新 TurnId 不能反向改变旧记录语义。

## 继续暂停或中断的运行

```powershell
coremind run coremind.yaml --resume <runId> --json-events
```

以下情况不会自动继续：配置指纹变化、operation 已终结、Effect Receipt 为 `started` 或 `unknown`、已提交副作用不属于稳定完成步骤、RunState 损坏。执行前被拒绝的工具使用 `not_started`，不会被误判为未知副作用。

Config 3 的 deferred 工具仍受同一恢复门约束：同一 Run 必须匹配原配置指纹，不能改配置后借旧选择集合扩权。目录快照、成功搜索与声明代次保存在私有追加事实中；公开 `context_prefix` 和 `provider_request` 只引用安全摘要。新 Run 根据当前配置重新建立声明，旧 Session、父级或上次 Run 的激活不构成授权。没有工具发现事实的旧 Run 沿原路径恢复，不推测历史工具集合。

同一 Run 内还须区分 execution。质量重试是新的 execution，即使 Agent 和 Step 相同也不复用旧激活。只有最后的权威暂停记录精确绑定待续 execution，才恢复该执行的目录与选择代次；已经成功完成的执行不成为待续项。崩溃没有精确绑定时，若原准入允许恢复，则从新的 deferred 声明开始，不猜最近同 Agent/Step 的旧状态。该私有绑定不会出现在公开投影或 Worker 事件中；它也不证明完整会话消息已经恢复。

从冷启动 Worker 读取同一批 Facts 并重投影，不等于已获准继续执行。继续执行仍须通过原输入、步骤边界、Effect Receipt 与所有权检查；搜索成功也不免除后续工具审批。

## 长日志关键提交的成本与边界

1.2 开发线在已成功发布的关键前缀上复用历史 JSON 文本；命中前仍在原 writer 锁内完整读取并精确比较 UTF-8 原文字符串，幂等 critical 提交仍执行同步屏障。缓存按游标最近更新顺序保留最多 64 个游标，驻留前缀总预算为 4 MiB UTF-8；淘汰前缀时只丢文本，不丢尾游标。

该预算不是 Store 总堆上限。显式读取、查询轮询、提交失败或外部改写会使下一次关键提交重新验证；缓存不跨 Store 实例或进程共享。命中只减少重复解析和序列化，完整读取、全量临时文件写入、同步与原子发布保留，不改变日志格式、恢复门或 critical 确认。固定长日志的 JSON 调用计数不代表整体生产吞吐、时延或物理 I/O 收益。

## 旧 Session

恢复旧文件时框架会自动创建 `.v3.backup`。受支持的消息、模型变更、工具集变更、压缩、分支摘要、标签和名称会迁移。无法无损表达的旧条目会返回明确错误，原文件保留；按 [SOP](SOP.zh-CN.md) 人工选择保留旧版本或导出有效上下文。

## 显式任务原子提交（1.4 发布线，internal）

需要把任务 checkpoint、业务 document 和相关文本一起保存时，由受信任宿主使用 `coremind-runtime/internal` 的 `TaskCommitSession`。这是内部存储基础，不是普通 `ChatSession` 的新模式，也不会执行任务、唤醒定时器或接入 Python/Worker。完整决策见 [ADR 0025](../../adr/0025-explicit-task-commit-authority.md)。

1. `open({ workspace, sessionId, documentSchemas })` 规范化已有工作区并独占任务会话；第二 writer 被拒绝。
2. `commit({ schemaVersion: 1, commitId, expectedRevision, taskId, task, documents, entries })` 全量校验后保存一个原子记录。成功回执含 commitId、新 revision 和 `durabilityBoundary`。
3. `snapshot()` 返回复制的 `{ revision, tasks, documents, entries }`。写入期间仍是旧投影，成功后整体切换；重开从提交事实完整重建。
4. `close()` 拒绝新提交，等待已经接收的提交结束，再释放租约。关闭后不能继续读取或提交。

`task` 是 `{ type, version, phase, checkpoint }`；这里只验证身份、正整数版本和 JSON 数据，不执行阶段或迁移。每个 document 为 `{ id, type, version, value }`，按 id 全量替换，无删除；每个 entry 为 `{ id, role: "user" | "assistant", text }`，只追加且 id 不能重复。

document 注册为 `{ type, version, schema }`，Schema 使用同步 JSON Schema draft-07。类型/版本必须注册，Schema 指纹随使用记录保存；重开时缺失或改变旧 Schema 会拒绝。禁止异步校验及未解析的网络引用；校验不会转换、删字段或填默认值。

所有 id、type、phase 为 1–128 个 ASCII 字母、数字、`_` 或 `-`，首字符须为字母或数字。输入及包含身份/Schema 指纹的事实 payload 分别限 1 MiB UTF-8；checkpoint/document value 必须是有限 JSON，不能带访问器、循环、Date、函数、BigInt 或 undefined。全会话共享 revision；同 commitId 和相同完整内容返回原回执，不再次追加，异内容拒绝。只改变 JSON 对象键顺序不影响幂等比较。

默认文件为 `<workspace>/.coremind/tasks/<sha256(sessionId)>/commits.jsonl`，绑定规范化工作区身份。不要复制到另一工作区后直接打开，也不要编辑或把 entry 再写入旧 Session。任务文件没有自动脱敏或加密。标准工具路径保护覆盖配置目录和 cwd 下的 `.coremind/tasks`；宿主自行选择其他工作区时也要配置相应写保护。

| 错误 | 处理 |
|---|---|
| `task_commit_invalid` | 修正整个提交或 document Schema，未发生本次写入 |
| `task_commit_conflict` | 检查 revision、commitId 内容和 entry id；不要自动生成新键重试 |
| `session_write_locked` / `policy_denied` | 核实 writer 与工作区/链接身份，不删活锁或绕过路径检查 |
| `task_store_corrupt` / `run_state_corrupt` | 保留原文件，核对 Schema、版本、身份和序列；任务日志不自动修剪尾行 |
| `durability_unsupported` | 自定义 Store 不满足原子 critical 与持久性合同，不能启用 |
| `durability_barrier_failed` / `task_store_unavailable` | 停用当前 holder，关闭后重开，核对原 commitId；失败可能已完整落盘，不代表回滚 |

自定义 `store(directory)` 是宿主信任接口，须声明 `atomicCriticalCommit: true`、支持 `critical`、至少 `process_crash`，提供原子单记录写入及匹配持久回执；读取不得静默修复任务事实。用 FileRunStore 实现时设置 `repairTornTail: false`。若暴露 `pathFor`，文件必须属于当前租约。能力声明不等于对任意 Adapter 的认证。

内置 Store 仅承诺进程崩溃边界，不覆盖系统断电或外部支付/建单。读取需全量重建，critical 仍重写完整日志，适合受控规模的单机任务；不是分布式队列或无限历史存储。运行[无模型事务示例](../../../examples/modules/recover-durable-runs/README.zh-CN.md)核对可见性、重开与幂等行为。

新增共享错误码会改变 Protocol v2 Schema 指纹，SDK/Worker/manifest 须配套更新；对公开 RunStateKind 做穷尽匹配的宿主需处理新的 `task_commit`，普通 Run 不会产生它。回滚时先停止 writer、保留任务目录，再恢复配套旧 SDK/Worker；旧三个事实域不需迁移，旧版本不读取新任务日志，也不能将其复制成旧 Session 或 Run 文件。

## 新手最容易犯的错误

- 把 `paused` 当作失败后自动重试信号。
- 看到文件已变化，就假设远端副作用也成功。
- 手工删除锁，却没有先确认是否仍有 writer。
- 只备份新格式文件，遗漏自动生成的旧文件备份。
- 终端关闭后用新 prompt 重跑，导致不可幂等工具重复执行。
- 把本机 `.coremind` 运行产物当作可复现的 Gate fixture。

运行 [模块示例](../../../examples/modules/recover-durable-runs/README.zh-CN.md) 后，再把恢复策略接入具体业务。

## 公共持久任务阶段（1.4 发布线）

`coremind-ai` 的 `TaskSession` 在上述存储基础上提供 start/query/resume/cancel 与显式版本迁移。每次 resume 执行一个阶段，模型/工具使用既有 Runtime；有 pendingRunId 时先保全原 Run，不自动重发。详见[公共任务指南](../../guides/durable-tasks.zh-CN.md)与 [ADR 0026](../../adr/0026-task-phases-and-migrations.md)。本说明对应 1.4.0 发布线，公开状态以同版本 Release、Registry 与资格证据为准；TS 与同步/异步 Python 已通过同一 Worker 接入，见[跨语言指南](../embed-coremind-python/GUIDE.zh-CN.md)。显式稳定键调用见下文。

## 持久等待（1.4 发布线）

阶段返回 sleepUntil 原子保存下一阶段与绝对期限；nextWake 查询最近持久等待，wake(taskId, wakeId, sleepId) 幂等置为 ready，再显式 resume。旧 alarm 不得推进新睡眠；宿主负责重启、恢复已知 ready 任务和重建计时器。取消使 alarm 失效，关闭空闲会话保留等待。等待不延长 Run、工具、阶段或 Worker 超时。用法、回执丢失处理和旧 SDK 回滚限制见[任务指南](../../guides/durable-tasks.zh-CN.md)与 [ADR 0027](../../adr/0027-durable-task-sleep-wake.md)。

## 稳定键调用（1.4 发布线）

runCalls 内 executeTool 的稳定键绑定参数、权限身份与顺序，一个阶段共享原 Run 的预算/权限/ChildRun 上限。calls 查询历史结果；未知外部效果仍暂停，已提交结果可从原 Run 协调。父任务终态不执行，历史受原 1 MiB 限制，不自动清理。兼容、回滚和宿主版本责任见 [任务指南](../../guides/durable-tasks.zh-CN.md) 和 [ADR 0028](../../adr/0028-keyed-task-calls.md)。
