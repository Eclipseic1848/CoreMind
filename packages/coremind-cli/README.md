# coremind-cli

## 简体中文

CoreMind 命令行与 TUI 客户端，提供 `create`、`run`、`chat`、`check`、`eval`、`doctor` 和 `templates`。

意外中断或显式暂停的运行可用 `coremind run <file> --resume <runId>` 从已持久化的稳定边界继续；不安全重放会被拒绝。

TUI、普通终端和 `--json-events` 都会显示相同的 `loop_state` 顺序；工具执行同时保留 Effect Receipt。

在请求批准模式中，按 Enter 或 `n` 拒绝工具后，本轮会立即返回暂停，不会再次请求模型或重复弹出同一审批。被拒绝的工具不会执行；用户可调整任务或权限后重新发起运行。

`coremind eval` 同时支持兼容文本断言的 schemaVersion 1 与多证据 schemaVersion 2；后者可验证终态、工具轨迹、命令、文件、Git 差异、运行状态和最终回答。

无头运行退出码为 `0/1/2/3/124/130`；`--json-events` 最后一行固定为 `run_result`，且不能与 `--print` 同时使用。

配置驱动的委派完成后，普通 `run` 输出会逐个显示 Child Run 的 RunId、目标 Agent、状态和结果摘要。`--json-events` 会在最终 `run_result` 前输出 `type: "child_run"` 的稳定记录，包含 ParentRunId、ChildRunId、DelegationId、目标、状态、Outcome 和 Recovery；两种输出都来自同一持久化 Fact Projection，不提供独立 spawn、list、resume 或 detach 命令。

TUI 默认摘要会突出 Child Run 数量、活动后代和未处置风险；运行中也可用 `/children` 从当前 canonical Facts 的统一 Projection 展开多层父子身份、目标、预算、状态、Outcome、Recovery 和风险正文。`delegate` 审批卡只摘要显示目标、任务、显式引用和收紧预算，并明确委派批准不预先批准子级 Effect。当前取消 authority 只有 `/abort`，它中止父级回答并由 Runtime 传播到活动 Child Run；未授权的子级独立取消或失败处置不会显示。`/status`、`/artifacts`、`/context`、`/observability` 可继续核对恢复、评测、产物、缓存、压缩和本地观测；JSONL 的 `run_result.snapshot` 与 `run_result.observability` 和两个 SDK 使用同一 Fact Projection。观测视图显式区分本地状态与 Telemetry 外传，并声明 `handed-off` 不等于接收端 delivered。

所有 CLI/TUI/TypeScript/Python 入口共享 Runtime 委派矩阵：`ask` 每次批准，`assisted` 只自动批准 Config 显式预批准的合规目标，`full` 也不能覆盖 deny、预算或其他硬边界。审批绑定目标、任务、引用和实际预算的指纹；Child Run 后续工具和外部 Effect 继续独立审批。

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

After a configured delegation completes, regular `run` output lists each Child Run ID, target agent, status, and result summary. Before the final `run_result`, `--json-events` emits stable `type: "child_run"` records with ParentRunId, ChildRunId, DelegationId, target, status, Outcome, and Recovery. Both views come from the same persisted Fact Projection; there are no standalone spawn, list, resume, or detach commands.

The default TUI summary highlights Child Run count, active descendants, and unhandled risk. While a run is active, `/children` expands current canonical Facts through the unified Projection into a nested tree with identities, targets, budgets, status, Outcome, Recovery, and risk text. `delegate` approval cards summarize the target, task, explicit references, and tightened budget while stating that delegation approval does not pre-approve child Effects. The only current cancellation authority is `/abort`, which aborts the parent response and is propagated by Runtime to active Child Runs; unauthorized child-specific cancellation or failure disposition is not displayed. Use `/status`, `/artifacts`, `/context`, and `/observability` to inspect recovery, evaluation, artifacts, cache, compaction, and local observations. `run_result.snapshot` and `run_result.observability` share one Fact Projection with both SDKs. The view separates local state from Telemetry egress and states that `handed-off` does not mean receiver-side delivery.

All CLI, TUI, TypeScript, and Python entry points share the Runtime delegation matrix: `ask` approves every request; `assisted` auto-approves only a compliant target explicitly pre-approved in Config; and `full` cannot override deny rules, budgets, or other hard boundaries. Approval binds the target, task, references, and effective limits by fingerprint, while child tools and external Effects remain independently approved.

```bash
npm install -g coremind-cli@next
coremind help
```

[Full documentation](https://github.com/Eclipseic1848/CoreMind)
