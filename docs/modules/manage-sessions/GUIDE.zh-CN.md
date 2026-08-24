# Session 与 Context上手指南

## 什么时候使用

保存多轮消息、严格恢复损坏错误，并在 Provider 调用前进行确定性的上下文保护。

## 最小示例

```text
session:
  enabled: true
  dir: ./.coremind/sessions
  compact: false
```

只有启用后才能使用 CLI 的 `--session <id>`。如果配置未启用，CLI 会明确失败并提示修正。

`session.compact` 控制旧 `ContextProtector` 行为，不会关闭 Runtime 的模型感知预算。只要当前请求超过可用输入预算，Runtime 就会尝试构建有界 Working Set；若确实需要压缩，必须同时存在已启用且可写入的 Session，摘要不能只保存在进程内存中。

不同模型的窗口和输出上限可以不同。Runtime 会在每次请求和模型切换时重新解析能力，并将本次实际 `maxTokens` 原样纳入预算；不会用窗口比例静默缩小调用方请求。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对旧保护器注入一次压缩失败，确认原消息保留并出现 `context_compaction_failed`；再对模型感知生命周期注入未知能力、无 Session 压缩、Artifact 漂移和 lineage 损坏，确认出现 `context_lifecycle_failed` 且 Provider 调用计数为 0。
6. 用至少两个不同窗口的模型配置重复长任务，检查 `context_budget_resolved` 的来源、置信度、实际输出保留量和各项输入占用。
7. 触发压缩后检查摘要六个必备部分、上一完整 Turn、当前 user 消息、Session 条目引用和 Ledger 父链；连续压缩达到阈值时确认从 canonical Session 消息重建。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把估算 token 当成 Provider 的绝对真值；边界误差由安全余量和 Provider 超窗后的单次暂停处理，不能重发同一请求碰运气。
- 不要在关闭 Session 的长任务中依赖内存摘要；需要压缩时 Runtime 会暂停。
- 不要把继承 Provider 误称为已通过真实认证。
