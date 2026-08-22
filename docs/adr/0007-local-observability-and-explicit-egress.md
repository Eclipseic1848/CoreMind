# 本地观测默认显性，遥测外传必须明确

运行可观测性对调试长任务是基础能力，但把“本地看得见”与“向外部 OTel 后端发送”绑定会造成隐蔽的数据外传。本决策声明：本地运行过程、工具调用、耗时、错误和当前共享状态默认显性展示；Telemetry Egress 采用 `DISABLED / FEEDBACK_ONLY / FULL` 明确模式并默认 `DISABLED`。开启外传后仍默认只发送脱敏指标，完整正文需要第二次明确授权。

## Status

accepted（2026-08-22 用户确认）

## Considered Options

- **观测能力全部默认关闭**：被否。用户无法及时知道任务、工具、错误和共享状态，长期任务的可解释性不足。
- **默认实时外传完整事件**：被否。提示词、回复、工具参数、文件内容和工作目录可能跨越用户预期的信任边界。
- **本地显性 + 外传分级授权**（采纳）：本地 Projection 默认可见；外传状态、目标和范围始终公开，`FEEDBACK_ONLY` 与 `FULL` 都要求显式配置，内容正文另设授权门。

## Consequences

- OTel 只是从 Fact 派生的可丢弃 Projection，不参与恢复、重放或终态判定。
- `DISABLED` 不创建外部 Exporter；仅配置 endpoint 不视为同意发送。
- Exporter 故障、丢失、重复或 shutdown 超时不得改变任务结果，也不得阻塞权威 Fact 落盘。
- 外传前必须执行 CoreMind 自有的脱敏和字段允许列表；未配置规则不能等价为“原样发送”。
- 详细合同与验收见 [0.3.x-C 可观测性规格](../spec/0.3.x-c/02-observability-and-egress.md)和[验收矩阵](../spec/0.3.x-c/03-acceptance-matrix.md)。
