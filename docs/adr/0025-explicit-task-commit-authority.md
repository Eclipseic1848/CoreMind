# 显式任务模式的原子提交与唯一权威

## Status

accepted for the v1.4.0 development line; internal storage contract, not release qualification.

## Context

[ADR 0001](0001-fact-domains-and-projections.md) 保留 Session、Run、Workspace 三个互不重叠的事实域。依次写这三份日志不能承诺“文本 entry、typed document、任务 checkpoint 一起提交”。本决策仅为显式任务模式增加 TaskCommit 事实域，不迁移旧数据，不改变普通 ChatSession、Workflow、Run 恢复或 Provider 请求重建。

## Decision

- `coremind-runtime/internal` 导出 `TaskCommitSession.open/commit/snapshot/close`。宿主显式提供工作区、会话身份和 document Schema 注册表；本项不增加公共 SDK、Worker 命令、调度器或上游扩展兼容。
- 每次 `TaskCommit` 包含 `schemaVersion: 1`、`commitId`、`expectedRevision`、`taskId`、一个完整 TaskCheckpoint、document 更新和文本 entry。整个 payload 是唯一权威；三个视图都是可丢弃、可重建的投影。它们不再同步写入旧 Session 日志，避免双重权威。
- 默认位置为规范化工作区下 `.coremind/tasks/<sha256(sessionId)>/commits.jsonl`。记录绑定规范化工作区的哈希与大小写敏感的 sessionId；Windows 路径身份不区分大小写。复制或移动到另一工作区不会静默恢复。
- 物理上复用 `FileRunStore` 的单记录 `critical` 提交与 `RunStateRecord` 信封。这里的 `runId: "commits"` 是存储键，`kind: "task_commit"` 标识独立 TaskCommit 域，不代表一个 Run；不得混入 `.coremind/runs` 或交给 RunSnapshot 归约器。
- 同一任务会话只有一个长期 writer 租约；同进程提交串行化。全会话 revision 从 0 开始，每次新提交加 1。旧 revision 拒绝；同 commitId 和完整相同内容返回原回执，不重复写入，异内容拒绝。JSON 对象键顺序不影响幂等比较，数组顺序影响比较。
- 在任何持久 I/O 前复制并验证全部输入、document Schema 与大小。先同步完整临时日志并原子替换，再同步发布全部内存投影。FileRunStore 只承诺 `process_crash`，不承诺系统崩溃、断电或外部业务 exactly-once。
- 失败不得发布部分投影。若落盘结果未知或回执不符，当前 holder 停止使用；关闭后重开，从事实核对原 commitId。失败不代表一定没有提交，不能换新 commitId 盲目重做外部副作用。
- 默认任务 Store 设置 `repairTornTail: false`：原子替换的任务日志损坏时保留原件并失败关闭。旧 Run 的尾部修复默认值保持。自定义 Store 是受信任宿主 Adapter，必须明确声明原子 critical 提交和至少 process_crash 持久性，提供完整有序且不静默修复的读取，并返回匹配回执；声明不是对任意实现的自动认证。

## Validation and limits

document 的 `(type, version)` 显式注册同步 JSON Schema draft-07；不加载网络引用、不执行异步校验、不改写数据。每条事实保存用到的 Schema 指纹，重开拒绝缺失或漂移的 Schema。TaskCheckpoint 的 type/version/phase 在本项只是受验证的身份元数据，执行状态机和迁移另行实现。

单个输入与含身份/Schema 指纹的事实 payload 均最多 1 MiB UTF-8，拒绝非 JSON、访问器、循环、非有限数与未知 schemaVersion。document 是按 id 全量替换，无删除；entry 只追加唯一 id 的 user/assistant 文本，不支持工具或图像消息。任务文件保存完整业务数据，没有自动脱敏或加密；宿主负责凭据隔离和文件访问权限。

目录符号链接、事实文件硬链接/符号链接和路径穿越拒绝；标准 Runtime 工具权限保护配置目录与 cwd 下的 `.coremind/tasks`。这是受控工具路径保护，不是针对恶意宿主代码或宿主竞态替换目录的 OS 沙箱。自定义宿主工作区也必须纳入其工具写保护。

恢复读取完整历史，critical 写入仍重写完整日志，投影在内存中重建；不是无限规模队列或分布式数据库。无自动压缩、跨会话事务、远端副作用回滚、JS 栈恢复或持久唤醒。

验证入口是 `task-commit.test.ts`、`task-commit-crash.test.ts` 和已有 Run/Session/request-rebuild 回归。真实子进程在发布前与持久提交后、投影前退出；Windows 与 Linux 分别验证旧状态/完整新状态、死主回收与竞争拒绝，不能相互替代。

## Compatibility and rollback

本决策落实 #362 已批准的增量合同。共享错误表增加四个任务错误，RunStore 增加可选原子性声明与尾部策略，RunStateKind 增加独立域使用的 `task_commit`。旧普通 Run 不会产生新 kind；对该公开联合类型做穷尽匹配的宿主须补充显式处理。Config 与 Protocol 版本不变，但 Protocol v2 的错误枚举指纹随码表变化，SDK、Worker 与 manifest 必须配套更新，不能绕过握手身份检查。

候选冻结基线仅更新这两份 API 报告及 v2 Schema 指纹，并记录变更原因；覆盖率、安全门、验收样本、超时、依赖身份与历史参考基线不变。旧 Session/Run/Workspace 无迁移。回滚前停止任务 writer、保留完整任务目录和旧发行包，恢复配套 SDK/Worker；旧版本继续读旧三个域，但不会读取新任务日志。不得删除任务日志或把它导入旧 Run/Session 来伪造兼容；后续重新启用须使用匹配 Schema 的新实现。

## Alternatives

- 三日志顺序写入：不能提供原子性，拒绝。
- 合并现有全部事实与迁移历史：超出本项，增加旧恢复路径风险，拒绝。
- 新数据库或外部持久任务执行器：当前单机存储合同可复用既有 critical writer，无需新增依赖。

## English contract summary

The opt-in internal TaskCommit domain extends ADR 0001 without migrating or duplicating legacy Session/Run/Workspace facts. One validated critical record owns the task checkpoint, typed document updates and text entries; every view is rebuilt from that record stream. `runId: "commits"` is only the reused storage envelope key, not an executable Run.

The built-in Store guarantees atomic visibility at the process-crash boundary, one active writer, optimistic revision checks and content-bound commitId idempotency. Uncertain I/O requires reopening and checking the original commitId, not assuming rollback. Torn task logs fail closed without repair; legacy Run repair stays unchanged. No remote-effect exactly-once, distributed scheduling, public SDK integration or task execution is claimed. See the [English guide](../modules/recover-durable-runs/GUIDE.en.md) for schema, size, path and operational limits.
