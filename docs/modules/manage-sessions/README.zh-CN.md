# Session 与 Context

状态：已发布的 `0.3.1` 稳定版；本文同时记录当前未发布源码中的模型感知 Context 生命周期合同。支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

保存多轮消息、严格恢复损坏错误，并在 Provider 调用前进行确定性的上下文保护。

## 公共接口

- `CoreMindSession`
- `ChatSession`
- `ContextProtector`

`ContextLifecycleManager`、`ContextWorkingSetBuilder` 和 `ContextTaskState` 通过 `coremind-runtime/internal` 供同仓库受控组件复用，不属于主公共入口。调用方通过 Runtime 事件、`RunOutcome`、Trace 与 Snapshot 观察其结果。

## 模型感知生命周期

- 每次请求按实际 Provider/model 解析 Context 窗口与输出上限；多个可信来源取安全交集，自定义端点缺少可信窗口时使用有明确 `assumed` 证据的保守值。
- 输入预算完整扣除本次实际 `maxTokens`、稳定前缀、工具 Schema、结构化输出、多模态占用、协议开销和安全余量。请求输出超过模型上限、图片占用未知或静态部分已经耗尽窗口时，会在 Provider 前失败关闭。
- 需要压缩时，Working Set 使用由 Runtime Facts 投影的 `TaskState` 替换旧前缀，并保留上一完整 user→assistant Turn 与当前未完成 user 消息。不可删除集合仍超预算时暂停，不做字符级截断。
- 每次压缩都把摘要和来源范围写入 Session，并把仅含指纹与父链的 Ledger Fact 写入运行事实。父链达到深度阈值后从 canonical Session 消息重建；损坏 lineage 不会被猜测修复。
- 受控 Artifact 在发送前重新验证路径、大小与 SHA-256。模型切换会重新预算；Provider 报告超窗时不会盲目重试同一请求。

## 错误与边界

- session_restore_failed：会话损坏时停止，不静默新建
- 旧 `ContextProtector` 压缩失败发出 `context_compaction_failed`；模型感知生命周期失败发出 `context_lifecycle_failed`，错误码为 `context_capability_conflict`、`context_budget_exhausted`、`context_artifact_missing` 或 `context_lineage_corrupt`
- 模型感知压缩必须绑定启用的持久化 Session；没有 Session 时只有无需压缩的请求可以继续，需要压缩的请求返回 `paused` 且不调用 Provider
- 成功解析预算发出 `context_budget_resolved`；成功压缩发出带 capability 指纹、lineage 深度、触发原因和 Session 条目引用的 `context_compacted`
- 摘要固定保留目标、约束、权限、已修改文件、测试状态和下一步

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/session.ts](../../../packages/coremind-runtime/src/session.ts)
- [packages/coremind-runtime/src/chat-session.ts](../../../packages/coremind-runtime/src/chat-session.ts)
- [packages/coremind-runtime/src/context.ts](../../../packages/coremind-runtime/src/context.ts)
- [packages/coremind-runtime/src/context-lifecycle.ts](../../../packages/coremind-runtime/src/context-lifecycle.ts)
- [packages/coremind-runtime/src/context-task-state.ts](../../../packages/coremind-runtime/src/context-task-state.ts)
- [packages/coremind-runtime/src/session.test.ts](../../../packages/coremind-runtime/src/session.test.ts)
- [packages/coremind-runtime/src/chat-session.test.ts](../../../packages/coremind-runtime/src/chat-session.test.ts)
- [packages/coremind-runtime/src/context.test.ts](../../../packages/coremind-runtime/src/context.test.ts)
- [packages/coremind-runtime/src/context-lifecycle.test.ts](../../../packages/coremind-runtime/src/context-lifecycle.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-sessions/README.en.md)
- [Agent Skill](../../../skills/manage-sessions/SKILL.md)
