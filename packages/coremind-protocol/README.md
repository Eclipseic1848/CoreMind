# coremind-protocol

CoreMind TypeScript 运行时与 Python SDK 共用的 JSON-RPC 协议、消息类型和运行时校验器。

本包主要服务于跨语言适配器和自定义 Worker 开发。业务应用通常无需直接依赖它，请优先使用 `coremind-ai` 或 Python 包 `coremind-ai`。

工具注册消息包含强制 `effect` 副作用声明。配置可以携带公开 `loop` 字段，事件流通过 `loop_state` 暴露稳定状态，但不暴露内部状态机实现。`resume_run` 同时支持安全的暂停与意外中断恢复。

`RunSnapshotSchema` 与 `parseRunSnapshot` 定义 CLI、Worker、TypeScript 和 Python 共用的纯 JSON 终态信封，包含 operation、outcome、metrics、evaluation、Trace、Checkpoint、Artifact、扩展收据和可恢复性。

Protocol v2 通过显式版本范围协商，在 `run`、`chat`、`resume` 接收客户端预生成的稳定 `runId` 并立即返回 `RunHandle`。客户端随后用 `events(afterSequence)` 续读 durable sequence、用 `query` 读取唯一 `ProjectionEngine` 投影，并把 Cancel、Approval、Steering、Follow-up 作为带稳定 `controlId` 的持久控制提交。重复 start/control 按指纹幂等；冲突、未知版本、混用 v1/v2 以及未知非 ignorable 事件均失败关闭。

`PROTOCOL_V2_SCHEMA_BUNDLE` 与 `PROTOCOL_V2_SCHEMA_FINGERPRINT` 同时锁定请求、初始化结果、RunHandle、事件信封、事件页、查询结果、控制回执和错误响应。v1 在整个 `0.4.x` 保留同步兼容入口，并返回非错误迁移提示；最早移除版本是 `0.5.0`，且仍需独立决策。

`ERROR_CODES` 是跨 Runtime、Protocol、Worker 与 SDK 的类型化 Error Contract 注册表，记录稳定字符串码、Run 终态、取消、重试和人工处置分类。`normalizeExternalErrorCode()` 保留未知外部码用于后续脱敏审计，但公开码固定收敛为 `unclassified_error`，对应暂停、人工处置和禁止自动重试。本阶段保留既有入口映射；调用方迁移与历史 Fact 审计将在后续 P0 任务完成。

## English: Protocol v2

Protocol v2 explicitly negotiates a version range, requires a stable client-generated Run ID for `run`, `chat`, and `resume`, and immediately returns a RunHandle. Clients then resume durable events by sequence, query the single ProjectionEngine, and submit durable controls with stable control IDs. Duplicate starts and controls are fingerprinted; conflicts, unknown versions, mixed v1/v2 envelopes, and unknown non-ignorable events fail closed.

`PROTOCOL_V2_SCHEMA_BUNDLE` and its fingerprint cover requests, initialization results, RunHandles, event envelopes and pages, query results, control receipts, and error responses. The synchronous v1 compatibility entry remains available throughout `0.4.x`; removal cannot be considered before `0.5.0` and still requires a separate decision.

`ERROR_CODES` is the typed Error Contract registry shared by Runtime, Protocol, Worker, and SDK consumers. It binds stable string codes to Run status, cancellation, retry, and human-action classifications. `normalizeExternalErrorCode()` retains an unknown external code for later redacted audit while constraining the public code to `unclassified_error`, which pauses for human handling and forbids automatic retry. This expand phase preserves existing entry-point mappings; caller migration and historical Fact audit remain follow-up P0 work.

任何不兼容协议变更必须同步升级 TypeScript、Python、内置 Worker 和协议标识，并通过跨语言与黄金样例测试；不得只更新一端。贡献流程见[贡献指南](https://github.com/Eclipseic1848/CoreMind/blob/main/CONTRIBUTING.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
