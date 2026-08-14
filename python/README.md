# CoreMind Python SDK

Python SDK 通过本地 stdio JSON-RPC 调用与 TypeScript/CLI 相同的 Node Runtime，不维护第二套 Agent Loop。

当前稳定包为已发布的 `coremind-ai==0.3.0`；完整中英文指南见仓库 `docs/modules/embed-coremind-python/`。

同步和异步客户端都提供 `resume_run(run_id, input=None)`。它只恢复 Node Runtime 判定为安全的暂停或意外中断运行，不会绕过配置指纹、输入一致性、Effect Receipt 或副作用核对。显式 Loop 的状态序列和终态与 TypeScript SDK 保持一致。

The Python SDK talks to the same Node runtime over local stdio JSON-RPC; it does not maintain a second Agent Loop. See `docs/modules/embed-coremind-python/` for the bilingual guide.

Both clients expose `resume_run(run_id, input=None)`. It resumes only paused or interrupted runs that pass the shared runtime checks, including configuration fingerprints and effect reconciliation. Explicit Loop state order and terminal results match the TypeScript SDK.

每次 `run`、`chat` 和 `resume_run` 都返回 `snapshot`：它是与 CLI JSONL、TypeScript SDK 相同的纯 JSON 权威快照。SDK 会校验 schemaVersion、runId 和 outcome；不一致时返回 `invalid_run_snapshot`，而不是接受错误状态。

Every `run`, `chat`, and `resume_run` response includes the same pure-JSON `snapshot` used by CLI JSONL and the TypeScript SDK. The client rejects schemaVersion, runId, or outcome mismatches with `invalid_run_snapshot`.

编码智能体使用同一 Node Runtime 的工具、Checkpoint、Trace 和终态。Python 项目可通过共享评测入口验证目标测试、回归测试、文件和差异；SDK 不在 Python 内重写另一套进程或 Git 执行语义。

Coding agents use the same Node runtime tools, checkpoints, traces, and terminal results. Python projects can validate target tests, regression tests, files, and diffs through the shared evaluation path; the SDK does not reimplement process or Git semantics in Python.

`@client.tool` 必须声明 `effect`。初始化或注册失败时，客户端会先关闭内置 Worker 再返回异常，不会遗留半启动进程。

`@client.tool` requires an `effect` declaration. Initialization or registration failures close the bundled Worker before the exception is returned, so callers do not need to clean up a partially started process.

发布前执行 `npm run build:python-worker`、`python -X utf8 -m build --wheel python`、Twine 和 `npm run release:check-wheel`。最后一项会在全新虚拟环境中安装 wheel，核对 `coremind.__version__` 与包元数据，并实际启动内置 Worker。

Before release, build the bundled Worker and wheel, run Twine, and run `npm run release:check-wheel`. The final gate installs the wheel in a clean virtual environment, compares `coremind.__version__` with package metadata, and starts the bundled Worker.
