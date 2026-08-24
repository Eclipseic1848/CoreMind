# Session 与 Context 开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 为需要续聊或可能触发 Context 压缩的长任务开启 Session；只在确认请求始终无需压缩时才可关闭。
2. 使用安全 sessionId。
3. 验证恢复后只追加新消息。
4. 核对实际 Provider/model 的 Context 窗口、输出上限与证据来源；未知、冲突、路由不匹配和超限输出必须在 Provider 前失败。
5. 观察 `context_budget_resolved`、`context_compacted`、`context_compaction_failed` 与 `context_lifecycle_failed`；失败时不得丢失原消息或重试相同超窗请求。
6. 检查摘要保留目标、约束、权限、已修改文件、测试状态和下一步，同时保留上一完整 Turn 与当前未完成 user 消息。
7. 核对压缩摘要已写入 Session、事件包含 Session 条目引用、Ledger 父链可验证；达到深度阈值时从 canonical Session 消息重建。
8. 对损坏 Session、无 Session 压缩、未知能力、请求输出超限、Artifact 漂移、模型切换、lineage 损坏与 Provider 超窗做失败注入，并断言适用场景的 Provider 调用计数为 0 或恰好 1。
9. 运行模块列出的测试，并执行 `npm run check:modules`。
10. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
