# coremind-cli

CoreMind 命令行与 TUI 客户端，提供 `create`、`run`、`chat`、`check`、`eval`、`doctor` 和 `templates`。

CoreMind CLI and TUI client with `create`, `run`, `chat`, `check`, `eval`, `doctor`, and `templates` commands.

意外中断或显式暂停的运行可用 `coremind run <file> --resume <runId>` 从已持久化的稳定边界继续；不安全重放会被拒绝。

Use `coremind run <file> --resume <runId>` to continue a paused or interrupted run from a persisted stable boundary. Unsafe replay is rejected.

TUI、普通终端和 `--json-events` 都会显示相同的 `loop_state` 顺序；工具执行同时保留 Effect Receipt。TUI, readline, and `--json-events` expose the same ordered `loop_state` events and preserve effect receipts.

`coremind eval` 同时支持兼容文本断言的 schemaVersion 1 与多证据 schemaVersion 2；后者可验证终态、工具轨迹、命令、文件、Git 差异、运行状态和最终回答。`coremind eval` supports schemaVersion 1 text assertions and multi-evidence schemaVersion 2 scenarios covering outcome, trajectory, commands, files, Git diff, runtime state, and response.

无头运行退出码为 `0/1/2/3/124/130`；`--json-events` 最后一行固定为 `run_result`，且不能与 `--print` 同时使用。Headless runs expose `0/1/2/3/124/130`; JSONL ends with `run_result`, and `--json-events` is mutually exclusive with `--print`.

```bash
npm install -g coremind-cli@next
coremind help
```

完整文档 / Full documentation: https://github.com/Eclipseic1848/CoreMind
