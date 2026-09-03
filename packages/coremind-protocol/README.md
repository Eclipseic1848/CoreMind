# coremind-protocol

CoreMind TypeScript 运行时与 Python SDK 共用的 JSON-RPC 协议、消息类型和运行时校验器。

本包主要服务于跨语言适配器和自定义 Worker 开发。业务应用通常无需直接依赖它，请优先使用 `coremind-ai` 或 Python 包 `coremind-ai`。

工具注册消息包含强制 `effect` 副作用声明。配置可以携带公开 `loop` 字段，事件流通过 `loop_state` 暴露稳定状态，但不暴露内部状态机实现。`resume_run` 同时支持安全的暂停与意外中断恢复。

`RunSnapshotSchema` 与 `parseRunSnapshot` 定义 CLI、Worker、TypeScript 和 Python 共用的纯 JSON 终态信封，包含 operation、outcome、metrics、evaluation、Trace、Checkpoint、Artifact、扩展收据和可恢复性。

Protocol v2 通过显式版本范围协商，在 `run`、`chat`、`resume` 接收客户端预生成的稳定 `runId` 并立即返回 `RunHandle`。客户端随后用 `events(afterSequence)` 续读 durable sequence、用 `query` 读取唯一 `ProjectionEngine` 投影，并把 Cancel、Approval、Steering、Follow-up 和 Delegation Disposition 作为带稳定 `controlId` 的持久控制提交。暂停 Run 的 Disposition 可先离线持久为 `accepted`，即使同一 Worker 正在执行另一个 Run；恢复并重建 Child Coordinator 后才成为 `applied` 或 `rejected`。重复 start/control 按指纹幂等；冲突、未知版本、混用 v1/v2 以及未知非 ignorable 事件均失败关闭。

v2 还定义脱敏的 Checkpoint `list/create/diff/restore` 与声明式动态工具 `tool_register/tool_call/tool_result`。恢复使用 OperationId 和当前文件摘要做幂等/CAS 保护；动态工具继续由 Node Runtime 的 Policy、Approval、Checkpoint 与 EffectReceipt 权威链执行，结果状态明确区分 duplicate、conflict、unknown 和 late。`PROTOCOL_V2_SCHEMA_FINGERPRINT` 固定全部公开 v2 Schema。

`approval_required` 与 `approval_resolved` 可携带同一 64 位小写十六进制 `argumentsFingerprint`，把批准和固定参数绑定；Delegation 审批还携带 `sha256:` 格式的 `delegationInputFingerprint`，其值必须与随后 `delegation_recorded.inputFingerprint` 相同。历史事件可省略这些字段，当前 Runtime 生成的新审批事实必须携带适用字段。

`PROTOCOL_V2_SCHEMA_BUNDLE` 与 `PROTOCOL_V2_SCHEMA_FINGERPRINT` 同时锁定请求、初始化结果、RunHandle、事件信封、事件页、查询结果、控制回执和错误响应。`0.7.1` 继续保留 v1 同步兼容入口，并返回非错误迁移提示；当前没有批准的移除时间表。任何移除都必须经过独立、版本化的弃用决策，并同步更新 TypeScript、Python、Worker 与迁移文档。

`ERROR_CODES` 是跨 Config、Runtime、Protocol、Worker、CLI、TUI 与双 SDK 的类型化 Error Contract 唯一注册表，记录稳定字符串码、恢复分类、兼容 Run 输出、取消、重试和人工处置分类。`ErrorCodeSchema`、Protocol v1/v2 错误响应、Run Outcome 公共类型与 v2 schema fingerprint 都从该注册表派生；Config 自有错误由跨模块类型门校验，Python SDK 随包携带构建生成且逐项校验的只读分类 JSON。未知外部码只以脱敏审计值进入 Outcome 与持久 Fact，公开码固定收敛为 `unclassified_error`，对应暂停、人工处置和禁止自动重试。`terminality` 与 `runStatus` 分别表达错误是否可恢复和兼容 Run 投影，因此可能不同，不得静默改写。

## English: Protocol v2

Protocol v2 explicitly negotiates a version range, requires a stable client-generated Run ID for `run`, `chat`, and `resume`, and immediately returns a RunHandle. Clients then resume durable events by sequence, query the single ProjectionEngine, and submit durable controls with stable control IDs, including Delegation Disposition. A paused Run may persist that control as accepted even while the same Worker executes another Run; only resume with a rebuilt Child Coordinator can record it as applied or rejected. Duplicate starts and controls are fingerprinted; conflicts, unknown versions, mixed v1/v2 envelopes, and unknown non-ignorable events fail closed.

Protocol v2 also defines redacted Checkpoint `list/create/diff/restore` operations and a declarative `tool_register/tool_call/tool_result` bridge. Restore uses operation identity plus a file-state compare-and-swap guard. Dynamic tools remain governed by the Node runtime's policy, approval, checkpoint, and effect-receipt chain; result receipts distinguish duplicate, conflict, unknown, and late states.

`approval_required` and `approval_resolved` may carry the same 64-character lowercase hexadecimal `argumentsFingerprint`, binding approval to fixed arguments. Delegation approvals also carry a `sha256:`-prefixed `delegationInputFingerprint` that must equal the subsequent `delegation_recorded.inputFingerprint`. Legacy events may omit these fields; new Runtime approval Facts include every applicable field.

`PROTOCOL_V2_SCHEMA_BUNDLE` and its fingerprint cover requests, initialization results, RunHandles, event envelopes and pages, query results, control receipts, and error responses. Version `0.7.1` continues to provide the synchronous v1 compatibility entry, and no removal schedule is approved. Any removal requires a separate, versioned deprecation decision plus coordinated TypeScript, Python, Worker, and migration updates.

`ERROR_CODES` is the single typed Error Contract registry shared by Config, Runtime, Protocol, Worker, CLI, TUI, and both SDKs. `ErrorCodeSchema`, Protocol v1/v2 error responses, public Run Outcome types, and the v2 schema fingerprint are derived from it. Cross-module type checks cover Config-owned codes, while the Python package ships a generated, read-only classification JSON that is checked entry-for-entry against the registry. Unknown external codes enter Outcomes and durable Facts only as redacted audit data and converge publicly to the pausing, human-handled, non-retryable `unclassified_error`. `terminality` and compatibility `runStatus` remain separate dimensions and must not be changed silently.

任何不兼容协议变更必须同步升级 TypeScript、Python、内置 Worker 和协议标识，并通过跨语言与黄金样例测试；不得只更新一端。贡献流程见[贡献指南](https://github.com/Eclipseic1848/CoreMind/blob/main/CONTRIBUTING.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
