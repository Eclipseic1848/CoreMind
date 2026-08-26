# CoreMind Python SDK

Python SDK 通过本地 stdio JSON-RPC 调用与 TypeScript/CLI 相同的 Node Runtime，不维护第二套 Agent Loop。

当前稳定包为已发布的 `coremind-ai==0.3.1`；完整中英文指南见仓库 `docs/modules/embed-coremind-python/`。

当前源码可用 `CoreMindClient(..., protocol_version="2.0")` 显式启用 Protocol v2；默认仍为 v1。v2 的 `run`、`chat` 和 `resume_run` 返回 `RunHandle`，调用方必须提供或由 SDK 预生成稳定 `run_id`；随后使用 `events(run_id, after_sequence=...)`、`query(run_id)` 与 `control(command)` 读取事件、投影和提交持久控制。`cursor_expired` 的 Projection snapshot 与新 cursor 可从 `ProtocolError.details` 读取。同步与异步客户端使用相同合同。

Protocol v2 当前不开放 Python callable 注册，也不暴露 v1 的 checkpoint diff/restore RPC；这些组合会返回 `protocol_capability_missing`，不会静默退回 v1。v1 在整个 `0.4.x` 保留，最早移除版本为 `0.5.0` 且需要独立决策。

同步和异步客户端都提供 `resume_run(run_id, input=None)`。它只恢复 Node Runtime 判定为安全的暂停或意外中断运行，不会绕过配置指纹、输入一致性、Effect Receipt 或副作用核对。显式 Loop 的状态序列和终态与 TypeScript SDK 保持一致。

The Python SDK talks to the same Node runtime over local stdio JSON-RPC; it does not maintain a second Agent Loop. See `docs/modules/embed-coremind-python/` for the bilingual guide.

Both clients expose `resume_run(run_id, input=None)`. It resumes only paused or interrupted runs that pass the shared runtime checks, including configuration fingerprints and effect reconciliation. Explicit Loop state order and terminal results match the TypeScript SDK.

Current source can opt into Protocol v2 with `CoreMindClient(..., protocol_version="2.0")`; v1 remains the default. v2 returns a `RunHandle` and exposes cursor-based `events`, Projection `query`, and durable `control` calls through the same bundled Node runtime. Controlled cursor recovery details are available on `ProtocolError.details`.

Protocol v2 does not currently support Python callable registration or expose the v1 checkpoint diff/restore RPCs. These combinations return `protocol_capability_missing` instead of silently falling back to v1. The v1 entry remains available throughout `0.4.x`; removal cannot be considered before `0.5.0` and still requires a separate decision.

每次 `run`、`chat` 和 `resume_run` 都返回 `snapshot`：它是与 CLI JSONL、TypeScript SDK 相同的纯 JSON 权威快照。SDK 会校验 schemaVersion、runId 和 outcome；不一致时返回 `invalid_run_snapshot`，而不是接受错误状态。

Every `run`, `chat`, and `resume_run` response includes the same pure-JSON `snapshot` used by CLI JSONL and the TypeScript SDK. The client rejects schemaVersion, runId, or outcome mismatches with `invalid_run_snapshot`.

当前源码的相同响应还包含 `observability`；`inspect_run()` 可从持久 Facts 重建该结构。Worker 宣告 `localObservability` 能力后，Python SDK 会校验 schema、Telemetry 模式、脱敏 origin、交付语义、非负计数和 consent 范围，损坏数据返回 `invalid_observability`。默认 `DISABLED` 的本地观测仍然可用，且不会构造 Exporter 或读取外传凭据。

Current source responses also include `observability`, and `inspect_run()` rebuilds it from persisted Facts. Once the Worker advertises `localObservability`, the Python SDK validates its schema, Telemetry mode, redacted origin, delivery semantics, non-negative counters, and consent scopes; malformed data returns `invalid_observability`. Local observations remain available in the default `DISABLED` mode without constructing an Exporter or reading egress credentials.

编码智能体使用同一 Node Runtime 的工具、Checkpoint、Trace 和终态。Python 项目可通过共享评测入口验证目标测试、回归测试、文件和差异；SDK 不在 Python 内重写另一套进程或 Git 执行语义。

Coding agents use the same Node runtime tools, checkpoints, traces, and terminal results. Python projects can validate target tests, regression tests, files, and diffs through the shared evaluation path; the SDK does not reimplement process or Git semantics in Python.

`@client.tool` 必须声明 `effect`。初始化或注册失败时，客户端会先关闭内置 Worker 再返回异常，不会遗留半启动进程。

`@client.tool` requires an `effect` declaration. Initialization or registration failures close the bundled Worker before the exception is returned, so callers do not need to clean up a partially started process.

发布前执行 `npm run build:python-worker`、`python -X utf8 -m build --wheel python`、Twine 和 `npm run release:check-wheel`。最后一项会在全新虚拟环境中安装 wheel，核对 `coremind.__version__` 与包元数据，并实际启动内置 Worker。

Before release, build the bundled Worker and wheel, run Twine, and run `npm run release:check-wheel`. The final gate installs the wheel in a clean virtual environment, compares `coremind.__version__` with package metadata, and starts the bundled Worker.
