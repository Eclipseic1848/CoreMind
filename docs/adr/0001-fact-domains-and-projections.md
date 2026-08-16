# 事实来源与投影的唯一关系

CoreMind 存在三份并行持久日志（会话树、RunState journal、checkpoint 文件）且无共享关联键，"哪些运行记录是唯一事实、其他状态如何由它推导"从未被声明。本决策声明：按事实域划分唯一事实——Session 事实（会话树）、Run 事实（RunState journal）、Workspace 事实（checkpoint 文件）各自权威、互不重叠，通过关联键显式连接；所有投影（RunSnapshot、会话上下文视图、CheckpointDiff、metrics、UI 状态）可丢弃、可从事实重建；运行时压缩摘要必须落盘为事实，使每次 Provider 请求可规范化重建。

## Status

accepted

## Considered Options

- **合并为单一事件日志**（deepseek-harness 形态）：物理合并三份日志。被否：范围爆炸，破坏 0.3.0 已验证的恢复证据与既有工具链，违背"不粗暴合并"约束。
- **维持现状**（三份日志无关联）：被否：重建 Provider 请求存在永久缺口（压缩摘要不落盘、会话与 Run 无关联、Turn 无身份），Web/Jobs/子智能体加入后投影漂移会恶化。
- **事实域划分 + 关联键**（采纳）：不移动现有物理格式，只补关联与准入规则，改动分层可控。

## Consequences

- RunState start 记录需携带 SessionId 与会话树 seq 范围引用；checkpoint 记录已有 toolCallId/idempotencyKey 关联，予以规范化。
- ContextProtector 的压缩产物（摘要文本、替换范围、指纹）落盘为会话树条目，使"实际发送给 Provider 的消息列表"可重建。
- RunSnapshot、buildContext 等投影不再被视为权威；恢复只读事实。
- 请求重建验收门：固定 fixture 的 Provider 请求可重建率 100%（见规格）。
