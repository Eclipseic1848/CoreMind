# 0.3.x-C 规格：本地可观测性与遥测外传

> 配套 ADR：[0007-local-observability-and-explicit-egress](../../adr/0007-local-observability-and-explicit-egress.md)
> 状态：accepted（2026-08-22 用户确认）

## 1. 两个独立能力

- **Local Observability**：在本机通过 CLI/TUI/TS/Python Projection 查看运行、工具、耗时、错误、Context、Artifact、RecoveryDecision 和共享状态。默认开启。
- **Telemetry Egress**：把可观测 Projection 发送到进程外的 OTel/OTLP 端点。默认关闭，必须显式授权。

禁用外传不得关闭本地可观测性；启用本地视图也不构成外传同意。

## 2. 共享模式

| 模式 | 行为 |
| --- | --- |
| `DISABLED` | 默认；不创建外部 Exporter，不读取外传凭据，不发送数据 |
| `FEEDBACK_ONLY` | 只有用户产生类型化 feedback consent 后，发送该 consent 覆盖的有界事实前缀 |
| `FULL` | 对新产生的允许字段持续投影并排队发送 |

- 未知模式失败关闭。
- 只配置 endpoint、环境变量或安装 exporter 包都不等于同意发送。
- `FEEDBACK_ONLY` 的 consent 必须是持久 Fact，包含范围、目标与内容级别；UI 点击或独立事件副本不得伪造授权。

## 3. 始终显性展示

CLI/TUI/SDK 查询至少返回：

- 当前模式与是否实际装载 Exporter；
- 目标端点的脱敏 origin，不显示凭据和敏感 query；
- 内容级别、字段允许列表与最后一次配置变更来源；
- `FEEDBACK_ONLY` 已授权范围；
- queued / handed_off / failed / dropped 等交付 Projection；
- 声明：交付状态不是权威 Fact，不承诺接收端已保存或保留多久。

## 4. 内容级别与第二次授权

默认内容级别为 `metrics_only`：

- 允许：Run/Turn/Call 的不透明关联 ID、事件类型、状态、耗时、计数、token usage、错误分类、Capability 类别、版本和脱敏平台信息。
- 禁止：提示词、回复正文、系统/项目指令、工具参数/结果、命令输出、文件内容、完整本地路径、环境变量值、审批正文、凭据和 URL 敏感参数。

完整正文属于 `content` 级别，必须独立于模式再次明确授权，并声明目标、字段范围、保留目的和撤销方式。`FULL + metrics_only` 不能被解释成正文授权。

## 5. Projection 与失败隔离

- Exporter 只消费 Fact 的脱敏 Projection，不写回 Session/Run/Workspace Fact。
- 同一 Fact 可被重复投影；接收端按稳定 identity 去重，CoreMind 不宣称 exactly-once telemetry。
- enqueue、batch、retry、drop、flush 与 shutdown 失败只产生本地观测，不改变 RunOutcome、RecoveryDecision 或 EffectState。
- Exporter shutdown 有界；到期后记录丢失可能性并允许 Runtime 收敛。
- OTel 不进入模型请求，也不能作为 Provider Context、Resume 输入或发布资格的唯一证据。

## 6. 脱敏与网络边界

- 外传前应用 CoreMind 自有 allowlist 与递归脱敏；没有规则时失败关闭，而不是原样发送。
- Exporter endpoint 受网络 egress policy 约束；DNS、重定向、代理和证书变化不得绕过配置目标。
- 凭据只在 Exporter Adapter 调用边界短暂读取，不进入 Fact、Projection、错误正文或配置指纹。
- 配置热变更先更新显性共享状态，再允许新记录进入新 Exporter；旧队列按明确 shutdown/abandon 规则处置。

## 7. 兼容与非目标

- 0.3.x-C 先建立本地 Projection 与可选 Exporter seam，不把第三方监控 SDK 类型暴露为 CoreMind 公共合同。
- 不承诺外部后端可用性、保存期限、告警正确性或费用。
- 本规格不授权真实 OTLP 端点、凭据、网络测试或新增依赖；这些仍需单独范围与批准。

## 8. 验收

实现验收见 [0.3.x-C 验收矩阵](03-acceptance-matrix.md)。
