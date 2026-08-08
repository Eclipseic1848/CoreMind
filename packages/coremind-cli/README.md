# coremind-cli

CoreMind 命令行与 TUI 客户端，提供 `create`、`run`、`chat`、`check`、`eval`、`doctor` 和 `templates`。

CoreMind CLI and TUI client with `create`, `run`, `chat`, `check`, `eval`, `doctor`, and `templates` commands.

意外中断的运行可用 `coremind run <file> --resume <runId>` 从已持久化的稳定步骤边界继续；不安全重放会被拒绝。

Use `coremind run <file> --resume <runId>` to continue an interrupted run from a persisted stable step boundary. Unsafe replay is rejected.

```bash
npm install -g coremind-cli@alpha
coremind help
```

完整文档 / Full documentation: https://github.com/Eclipseic1848/CoreMind
