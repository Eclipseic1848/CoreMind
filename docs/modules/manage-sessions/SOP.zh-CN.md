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

## 会话树验收（1.4 开发线）

1. 对比本地假 Provider 的真实请求，验证分支切换、独立进程重启和 fork 的祖先隔离；fork 前后原会话字节相同。
2. 活动 Run、第二 writer、旧快照、未知/跨会话节点、非法名称和路径在写入或请求前拒绝；新会话仍走新 Run 审批，不复制控制或执行记录。
3. 注入选择写前、坏尾、写后失去确认和 fork 别名失败，保留现场并重新打开确认事实；不盲目重跑。
4. 运行新增 chat-session-tree、session-navigation-fault 测试及原模块回归，执行 `node examples/modules/manage-sessions/branches.mjs`，核对 API、生成 Worker/错误合同和原门禁。
5. 旧 SDK 回滚先停 writer、保全完整事实域，恢复升级前备份；不让旧 writer 忽略新选择后继续 main。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。

当前源码修复：Run 结束阶段的 Session 摘要也消耗该 Run 的 turn、token 和 cost 预算，并受剩余 deadline 与取消信号约束。预算不足时跳过摘要、保留历史；请求和 usage 写入事实记录，失败用量未知时不能视作零消耗。验收时对比实际 Provider 请求数与 Run 请求事实数。
