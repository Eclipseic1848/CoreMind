# coremind-runtime

CoreMind 的智能体运行时，提供模型供应商解析、会话、工具调用、预算、检查点、上下文管理、质量评估、静态 Workflow 和显式有界 Loop。

所有调用统一返回成功、失败、暂停、中止、超时或预算耗尽终态。`LoopController` 封装内部状态机，提供 verify/repair、无进展检测、稳定快照和暂停恢复；只有验证通过才返回成功。

Runtime、Provider、Tool、Child Run 与 Evaluation 入口共用 Protocol 的 Error Contract。已登记错误保留稳定分类；未知外部异常统一返回暂停且禁止自动重试的 `unclassified_error`，原始外部错误码只以脱敏 `audit.originalCode` 写入 Outcome 与持久 Fact，避免泄露凭据或重复副作用。恢复投影要求人工处置，不会把未知错误猜成瞬态。

配置了 `agents.<parent>.delegation.targets` 后，Runtime 只在该父 Agent 的活动 Run 中注入内建 `delegate` 工具。调用只能选择 allowlist 目标、提交任务、显式 Fact/Artifact 引用和更严格的预算；Runtime 派生 Provider、Workspace、权限与生命周期，等待独立 Child Run 结束后返回带 `childRunId` 的结构化结果。未配置时工具不可见且不会产生 Child Run Fact。

成功 Child Run 在 join 后默认接受；失败、取消、超时和预算耗尽必须由 `dispose_delegation` 持久记录接受失败、替代方案、重新委派或传播终态，父 Run 才能继续或结束。重新委派只在 RecoveryDisposition 明确安全时允许，并要求新的 DelegationId、新预算和指向原尝试的 `recoveryOf`。恢复审计在任何新 Provider 请求前把失去所有权的活动子级持久化为 `child_orphaned → parent_joined`；orphan、已提交或未知 Effect、未静止和所有权不明要求人工处置。父级已有终态时会先暂停并保存该终态，处置完成后直接恢复，避免重复 Provider 请求。

Delegation 使用独立批准矩阵：`ask` 每次询问，`assisted` 只自动批准 Config 显式 `preapproved: true` 且满足全部限制的目标，`full` 只对合规请求免询问。显式 deny、目标 allowlist、预算、工具不扩权、路径、网络和凭据边界在审批前失败关闭。审批请求及 required/resolved 事实携带参数指纹，以及与实际 `delegation_recorded` 完全相同的 Child Run 输入指纹；任何改变都不能复用原批准。委派批准只创建 Child Run，子级 ToolPolicy 与 Effect 审批独立执行并写入子 Run 事实。

交互入口可在一轮运行期间调用 `ChatSession.inspectCurrentRunProjection()`，只读查询已经持久化的 canonical Facts，并通过唯一 `ProjectionEngine` 重建当前父子树。它不强制刷新 journal，也不暴露 Child Run Coordinator、内部 Map 或 Worker 私有状态；尚未产生持久 Fact 时返回 `undefined`。

工具副作用记录 `started`、`committed` 或 `unknown` Effect Receipt。恢复不重复完整步骤和已提交副作用，未知副作用要求人工核对。文件恢复还会检查工具执行后的指纹，拒绝覆盖用户或并发进程的后续修改。

Runtime 在 Policy 与 Checkpoint 前为每个 Call 记录一次 `capability_resolved` Fact，并让后续消费者复用同一份冻结 Capability。`projectToolCapabilities()` 为 CLI、TUI、TypeScript 和 Python 提供统一投影；读取 0.3.0/0.3.1 历史记录时，缺少该 Fact 的 Call 显式标记为 `legacy`、`unknown` 与 `requires_human`，不会根据旧工具名补写安全结论。

所有当前工具入口经过 `ToolExecutionEngine`：它既是从 `call_recorded` 依次推进到 `terminal` 的唯一阶段 reducer，也持有通过全部前置门禁后的一次性 Tool Adapter 调用权；不需要的阶段会记录 `skipped(reason)`。执行结果、Effect、持久化、恢复、清理、授权和环境是相互独立的结果轴；取消或超时会收敛开放 Call，迟到结果不能改写已持久终态。`projectToolCallLifecycles()` 是 Runtime、Worker 和 SDK 共用的离线投影。

`WorkspaceLeaseService` 把相对路径、symlink/junction 和 Windows 大小写折叠为 canonical root。Pure Local Read 使用 `parallel` lane，不创建写锁；`run_serial` 只串行同一 Run；`workspace_exclusive` 在 `<workspace>/.coremind/leases` 以完整 owner 候选文件加原子 hard-link 争抢本地文件系统单写租约。Lease 在 Checkpoint 前取得，在 Adapter、结果关键 Fact 和生命周期终态静止后释放；竞争返回 `workspace_busy`，不会无锁降级。Owner 进程退出或锁文件损坏时，新 Writer 先得到 `workspace_lease_recovery_required`，只有调用方用已审计的 owner nonce 显式 `recover()` 后才能重试；读取端可用 `projectWorkspaceLeasesFromRecords()` 重建状态，不为旧记录伪造 Lease Fact。该合同不覆盖网络文件系统或远程分布式锁。

`RunStore` 初始化时公开 `supportedDurability` 与 `durabilityBoundary`。旧 Adapter 可继续承担 `ordinary/process_memory`，但未声明并实现 barrier 时不能升级为 `critical`。`FactLedger.append()` 为每条新 Fact 返回绑定 `runId/sequence/eventId/durability` 和 Store acknowledgement 的 receipt；`ordinary` 只确认 Store 的普通边界，`critical` 必须完成该条 Fact 的精确 commit barrier。首次 commit 失败会 poison 当前 ledger，后续写入不会跳过序号继续发布；必须从 Store 的稳定前缀恢复新实例。旧 `0.3.0/0.3.1` 记录可继续读取，但读取端不会为其伪造 eventId 或 durability receipt。`MemoryRunStore` 仅支持 `ordinary/process_memory`，不能承载副作用工具的关键 Fact；`FileRunStore` 支持 `critical/process_crash`，在 acknowledgement 前同步已原子发布的 RunState 文件。Windows/Linux abrupt-exit probe 只证明 barrier 成功后的 Fact 可跨进程崩溃读取，不证明操作系统崩溃、设备缓存或掉电后的存续。unsupported 与 barrier failure 均在工具 Adapter 前失败关闭；工具已返回后的 result barrier failure 保留执行与 Effect 事实，只把持久化投影标为 failed。`FactLedger.metrics()` 分开统计 ordinary/critical 的 pending、成功、失败与延迟。File Store 可用 owner PID/nonce 回收普通 dead-writer lock；无法证明 owner 的旧格式/异常锁，以及回收者自身崩溃遗留的 claim，都会保持锁定并要求操作员核验后清理，不会冒险自动删除。

`ProjectionEngine` 同时生成默认开启的 `LocalObservabilityProjection`，`ReplayKit` 直接复用该唯一投影重建 Run、Context、Artifact、Recovery 与观测，并逐项核对实际 Provider Working Set fixture 与持久请求指纹。Telemetry 外传默认 `DISABLED`；启用模式必须与持久配置 Fact、脱敏 origin、字段范围和带 SHA-256 范围指纹的 consent 一致，content consent 还必须声明保留目的与撤销方式。Exporter 只接收 allowlist/递归脱敏副本，故障、丢弃、重复和 shutdown 超时不写回 Facts 或终态。该包只提供注入 seam，不绑定第三方 OTel 类型或真实 endpoint。`createTelemetryEgressAuthorization` 只构造可校验收据；实际 DNS、TLS、禁止 redirect/proxy 与精确 origin 策略必须由受信任 Adapter 执行，Core 不把收据冒充成网络认证证据。

`ControlInbox` 与当前 Run 的 `RunStateJournal` 共用单一 Fact writer。Cancel、Approval、Steering 和 Follow-up 先持久化为 accepted，再在可应用点写入 applied 或 rejected；相同 `controlId` 与相同指纹返回 duplicate，不同内容返回 conflict。ACK 只证明对应阶段已持久化，不把 Cancel ACK 冒充为 Quiescent。`ProjectionEngine` 从 Facts 重建 pending controls，Host 或连接重启后可以重试未决控制而不重复已应用副作用。

Delegation Disposition 同样进入该持久 ControlInbox。Protocol Host 可在 Run 已暂停且 Runtime 不活动时先返回 `accepted`；恢复并重建 Child Coordinator 后才应用语义校验并写入 `applied` 或 `rejected`。

## English: Durable controls

Runtime, Provider, Tool, Child Run, and Evaluation entry points share the Protocol Error Contract. Registered errors retain their stable classifications. Unknown external failures become the pausing, non-retryable `unclassified_error`; only a redacted `audit.originalCode` is retained in the Outcome and durable Fact. Recovery requires human disposition instead of guessing that an unknown failure is transient.

Delegation uses a dedicated approval matrix: `ask` prompts for every request; `assisted` auto-approves only a Config target explicitly marked `preapproved: true` when every hard boundary passes; and `full` skips prompts only for compliant requests. Explicit deny rules, the target allowlist, budgets, non-expanding tools, paths, network, and credentials fail closed before approval. Required and resolved approval Facts carry both an argument fingerprint and the exact Child Run input fingerprint later persisted by `delegation_recorded`. Delegation Approval creates only the Child Run; the child's ToolPolicy and Effect approvals remain independent child Run Facts.

A successful joined Child Run is accepted by default. Failure, cancellation, timeout, and budget exhaustion require a durable disposition before the parent may continue or terminate. Redelegation requires an explicitly safe RecoveryDisposition, a new Delegation ID, a new budget, and a `recoveryOf` link. Before any new Provider request, recovery persists a lost-ownership active child as `child_orphaned → parent_joined`; orphaned execution, committed or unknown effects, non-quiescence, and unclear ownership then require a human decision. If the parent already has a terminal error, Runtime pauses and preserves it until the Child disposition is complete, then restores it without another Provider request.

During an interactive turn, `ChatSession.inspectCurrentRunProjection()` provides a read-only view of already persisted canonical Facts rebuilt by the single `ProjectionEngine`. It does not force a journal flush or expose the Child Run Coordinator, internal maps, or Worker-private state, and returns `undefined` before any durable Fact exists.

`ControlInbox` shares the current RunStateJournal's single fact writer. Cancel, Approval, Steering, and Follow-up are persisted as accepted before an applicable point records applied or rejected. The same control ID and fingerprint returns duplicate; different content returns conflict. An acknowledgement proves only its persisted stage and never represents Cancel as Quiescent. ProjectionEngine rebuilds pending controls from facts, so a Host or connection restart can retry unresolved controls without repeating an applied effect.

Delegation Disposition uses the same durable inbox. A Protocol Host may persist it as accepted while a Run is paused and no Runtime is active; only a resumed Runtime with a rebuilt Child Coordinator may record it as applied or rejected.

## English: Tool lifecycle

Every current tool entry point passes through `ToolExecutionEngine`. It is both the single phase reducer from `call_recorded` to `terminal` and the owner of the one-shot Tool Adapter invocation after all pre-execution gates pass; unused phases are recorded as `skipped(reason)`. Execution, effect, persistence, recovery, cleanup, authorization, and environment remain orthogonal result axes. Cancellation and timeout converge open calls, and late results cannot rewrite a persisted terminal state. Runtime, Worker, and SDK consumers share the offline `projectToolCallLifecycles()` projection.

`WorkspaceLeaseService` folds relative paths, symlinks or junctions, and Windows path casing into a canonical root. Pure Local Reads use the `parallel` lane without a write lock; `run_serial` serializes only one Run; `workspace_exclusive` atomically hard-links a complete owner candidate under `<workspace>/.coremind/leases` to enforce one writer on a local filesystem. The Runtime acquires the Lease before Checkpoint and releases it only after the Adapter, critical result Fact, and lifecycle terminal are quiescent. Contention returns `workspace_busy` without an unlocked fallback. A dead owner or malformed lock yields `workspace_lease_recovery_required`; a caller must explicitly `recover()` the audited owner nonce before retrying. `projectWorkspaceLeasesFromRecords()` rebuilds persisted state without fabricating Lease Facts for legacy records. Network filesystems and remote distributed locking remain out of scope.

Each `RunStore` declares `supportedDurability` and `durabilityBoundary` at initialization. A legacy Adapter may continue at `ordinary/process_memory`, but it cannot upgrade to `critical` without declaring and implementing a barrier. Every new `FactLedger.append()` returns a receipt binding `runId/sequence/eventId/durability` to the Store acknowledgement. `ordinary` acknowledges the Store's ordinary boundary; `critical` requires an exact per-Fact commit barrier. The first commit failure poisons that ledger, so later writes cannot skip the failed sequence and publish a misleading suffix; recovery creates a new ledger from the Store's stable prefix. Legacy `0.3.0/0.3.1` records remain readable without fabricated event IDs or durability receipts. `MemoryRunStore` supports only `ordinary/process_memory` and cannot carry safety-critical Facts for side-effecting tools. `FileRunStore` supports `critical/process_crash` by synchronizing the atomically published RunState file before acknowledgement. Windows and Linux abrupt-exit probes prove only that acknowledged Facts remain readable after a process crash; they do not claim survival across an operating-system crash, device-cache loss, or power loss. Unsupported durability and pre-execution barrier failures fail closed before the Tool Adapter. A result barrier failure after a Tool returns preserves the execution and Effect facts while projecting persistence as failed. `FactLedger.metrics()` reports pending, success, failure, and latency separately for ordinary and critical commits. The File Store can reclaim an ordinary dead-writer lock whose owner PID and nonce are provable. Legacy or malformed locks with no provable owner, and a claim abandoned by a crashing reclaimer, remain locked for operator-verified cleanup instead of being deleted speculatively.

`ProjectionEngine` also produces the always-on `LocalObservabilityProjection`, and `ReplayKit` reuses that single projection to reconstruct Run, Context, Artifacts, Recovery, and observations while matching actual Provider Working Set fixtures against persisted request fingerprints. Telemetry egress defaults to `DISABLED`; enabled modes must match the persisted configuration Fact, redacted origin, field scope, and SHA-256 scope-fingerprinted consents, while content consent also declares retention purpose and revocation method. The Exporter receives only allowlisted and recursively redacted copies, while failures, drops, duplicates, and shutdown timeouts cannot write back to Facts or outcomes. This package exposes an injection seam without binding public contracts to third-party OTel types or a live endpoint. `createTelemetryEgressAuthorization` only constructs a verifiable receipt; actual DNS, TLS, redirect/proxy denial, and exact-origin enforcement belong to the trusted Adapter, and Core does not present a receipt as network certification.

人工或策略拒绝工具后，当前智能体循环会在本批工具结果完成归并后立即暂停，不再请求下一轮模型或重复申请审批。拒绝仍记录为 `tool_approval_denied`，且被拒绝的工具不会产生副作用。

Evaluation schemaVersion 2 提供 outcome、trajectory、command、file、diff、state、response 七类 grader，并在执行前记录受保护文件与脏工作区基线。一次 Runtime 成功、一次预期测试失败、最终代码正确和是否可以发布是不同结论，必须分别记录。

Trace 事件在持久化和转发前统一脱敏：密钥、Token、口令、认证头、Cookie、私钥、URL 敏感参数和命令中的敏感值不进入 RunState；正常测试命令仍保留可审查性。该防线不代替本地文件访问控制和业务数据保留策略。

该包适合需要组合底层运行能力的框架扩展者。面向业务开发时，建议从 `coremind-ai` 的稳定入口开始，避免直接依赖内部模块。

> 当前为预发布版本。公开 API、配置结构和执行语义仍可能按发布说明调整，请在升级前阅读变更日志。

安全边界与平台差异见[安全策略](https://github.com/Eclipseic1848/CoreMind/blob/main/SECURITY.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
