# 0.3.x-C 规格：上下文、观测与重放验收矩阵

> 配套规格：[长程上下文](01-long-horizon-context-lifecycle.md)、[可观测性与外传](02-observability-and-egress.md)
> 状态：accepted（2026-08-22）
> 本文件定义未来实现门，不声称门已经通过

## 1. Context Capability 与预算

- 内置目录、显式配置、Provider metadata、fallback 的组合 fixture 验证安全交集，不得选取更大冲突值。
- 自定义端点缺少窗口时产生 `assumed_context_window`；用户收紧值立即用于下一次请求。
- 工具 Schema、稳定前缀、结构化输出、最大输出和安全余量逐项加入后，发送请求始终低于硬预算。
- token 估算偏低、图片占用未知和 Provider 报告超窗时，禁止相同请求无限重试。

## 2. 长程任务

- 使用 `1M → 128K → 32K → 8K` 模型窗口切换 fixture；每次切换后重新解析能力、重建工作集并通过预算。
- 连续至少 50 次压缩后，从 canonical facts 重建的 TaskState、不可删除集合和最终请求与实际发送值一致。
- 达到 lineage depth 阈值后证明新基线来自 facts，而不是只对上一摘要继续摘要。
- 压缩回调失败、Compaction Ledger 尾部损坏、Artifact 丢失和不可删除集合超限均产生明确错误或暂停，不静默丢消息。
- 目标、约束、审批、未知 Effect、文件与测试状态、未完成步骤在全部 fixture 中可回溯到来源 Fact。

## 3. 本地可观测性

- OTel 未安装、未配置或 `DISABLED` 时，CLI/TUI/TS/Python 仍可看到同一 RunSnapshot、Context、工具阶段、错误与共享状态。
- 四入口对模式、脱敏 endpoint、内容级别、queue/drop Projection 的结果结构等价。
- 删除全部观测 Projection 后，可以从 Fact 重建；Run Resume 不读取观测缓存。

## 4. Telemetry Egress

### DISABLED

- 不构造 Exporter，不读取外传凭据，网络调用计数为 0。
- 即使 endpoint 环境变量存在也保持 0 次外传。

### FEEDBACK_ONLY

- 无持久 feedback consent 时外传计数为 0。
- consent 只释放声明范围，范围外新事件保持本地。
- 伪造 UI 事件、重放独立对象或范围指纹不匹配均不产生外传。

### FULL

- 只发送配置生效后的允许字段；历史记录不自动回补。
- `metrics_only` 捕获端断言不存在提示词、回复、工具参数/结果、命令、文件正文、完整路径或凭据。
- 开启 `content` 必须存在第二个独立 consent Fact，并限制目标与字段范围。

### 故障隔离

- 注入 DNS、TLS、401、429、timeout、queue full、重复发送、shutdown 卡住；RunOutcome、Fact sequence 与 RecoveryDecision 保持不变。
- 外传副本重复时 identity 稳定；本地 UI 明确显示 handed-off 不等于 delivered。
- 脱敏规则抛错时该记录失败关闭，不进入 Exporter，Agent Loop 继续。

## 5. Replay 与四入口

- 固定 Provider 请求 fixture 在 Runtime、CLI、TUI、TS 与 Python 入口逐条等价。
- 删除 Projection 后重建 Context Working Set、RunSnapshot 与本地观测；摘要指纹、来源范围和模型能力引用一致。
- 0.3.0/0.3.1 历史事实继续可读；不能重建的旧压缩或观测字段明确标记 legacy/unknown，不伪造当前能力。

## 6. 回归与证据边界

- 单元、属性、故障注入、请求重建、真实入口、Windows/Linux、typecheck、lint、public API baseline 与文档审计全部通过。
- 真实 Provider 的窗口、tokenizer、缓存与长上下文能力必须绑定当前候选重新认证；离线通过不能标记 Provider Certified。
- 真实 OTel endpoint、网络 egress、凭据和费用测试需要单独授权；本矩阵不自动授权。
