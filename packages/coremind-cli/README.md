# coremind-cli

## 简体中文

CoreMind 命令行与 TUI 客户端，提供 `create`、`run`、`chat`、`check`、`eval`、`doctor` 和 `templates`。

意外中断或显式暂停的运行可用 `coremind run <file> --resume <runId>` 从已持久化的稳定边界继续；不安全重放会被拒绝。

TUI、普通终端和 `--json-events` 都会显示相同的 `loop_state` 顺序；工具执行同时保留 Effect Receipt。

在请求批准模式中，按 Enter 或 `n` 拒绝工具后，本轮会立即返回暂停，不会再次请求模型或重复弹出同一审批。被拒绝的工具不会执行；用户可调整任务或权限后重新发起运行。

`coremind eval` 同时支持兼容文本断言的 schemaVersion 1 与多证据 schemaVersion 2；后者可验证终态、工具轨迹、命令、文件、Git 差异、运行状态和最终回答。

无头运行退出码为 `0/1/2/3/124/130`；`--json-events` 最后一行固定为 `run_result`，且不能与 `--print` 同时使用。

TUI 可用 `/status`、`/artifacts`、`/context`、`/observability` 核对恢复、评测、产物、缓存、压缩和本地观测；JSONL 的 `run_result.snapshot` 与 `run_result.observability` 和两个 SDK 使用同一 Fact Projection。观测视图显式区分本地状态与 Telemetry 外传，并声明 `handed-off` 不等于接收端 delivered。

```bash
npm install -g coremind-cli@next
coremind help
```

[完整文档](https://github.com/Eclipseic1848/CoreMind)

## English

CoreMind CLI and TUI client with `create`, `run`, `chat`, `check`, `eval`, `doctor`, and `templates` commands.

Use `coremind run <file> --resume <runId>` to continue a paused or interrupted run from a persisted stable boundary. Unsafe replay is rejected.

TUI, readline, and `--json-events` expose the same ordered `loop_state` events and preserve effect receipts.

In ask mode, pressing Enter or `n` denies the tool and pauses the run without another model request or a repeated approval prompt. The denied tool is not executed; start a new run after changing the task or permission choice.

`coremind eval` supports schemaVersion 1 text assertions and multi-evidence schemaVersion 2 scenarios covering outcome, trajectory, commands, files, Git diff, runtime state, and response.

Headless runs expose `0/1/2/3/124/130`; JSONL ends with `run_result`, and `--json-events` is mutually exclusive with `--print`.

Use `/status`, `/artifacts`, `/context`, and `/observability` to inspect recovery, evaluation, artifacts, cache, compaction, and local observations. `run_result.snapshot` and `run_result.observability` share one Fact Projection with both SDKs. The view separates local state from Telemetry egress and states that `handed-off` does not mean receiver-side delivery.

```bash
npm install -g coremind-cli@next
coremind help
```

[Full documentation](https://github.com/Eclipseic1848/CoreMind)
