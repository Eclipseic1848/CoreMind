# Session 与 Context

状态：合同与文档已对齐 `1.0.0` 发布线。支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

保存多轮消息、严格恢复损坏错误，并在 Provider 调用前进行确定性的上下文保护。

## 公共接口

- `CoreMindSession`
- `ChatSession`
- `ChatSession.steer/followUp(message, options?)`（1.1 开发线，`options` 为 `{ controlId?, runId? }`）
- `ContextProtector`

`ContextLifecycleManager`、`ContextWorkingSetBuilder` 和 `ContextTaskState` 通过 `coremind-runtime/internal` 供同仓库受控组件复用，不属于主公共入口。调用方通过 Runtime 事件、`RunOutcome`、Trace 与 Snapshot 观察其结果。

## 会话写入所有权

- 同一规范化目录和 Session ID 只允许一个活动写入者。Run 在读取执行历史前取得跨进程写租约，覆盖模型、工具、压缩、最终追加和取消收敛；实际文件操作另用短锁。不同会话不共用这把锁，文件所有权不授予工具权限。
- 启用 `session.enabled` 且提供 `sessionId` 时，`CoreMindRuntime.create()` 会建立或打开空会话，取得一致的预读消息与水位；此时不持长期租约，也不调用模型。普通 `run()` 在租约内刷新历史；Chat 保留自己的压缩视图，并核对来源水位。
- 竞争写入报告 `session_write_locked`；旧持有者追加或旧 Chat 继续报告 `session_snapshot_stale`，不修改文件、不自动合并分支。外部 Runtime 推进会话后，须重新创建 Runtime 从持久会话恢复，再创建 Chat；仅在旧 Runtime 上新建 Chat 不会刷新外部历史。同一 Chat 的正常连续轮次会传递新水位。
- 宿主通过 `runAgentTurn` 管理历史时，可以沿用上一轮返回的消息或浅复制数组。跨轮使用经 JSON 重建或深复制的历史时，重新创建 Runtime 从持久会话恢复，以重新取得可核验的来源水位。失效写身份报告 `session_write_lease_invalid`；锁损坏或释放失败需要按 `session_lock_recovery_required` 核验所有权，已报错的旧持有者须重新打开。
- 最后一次会话写入已完成且运行静止后，先封住旧写身份并释放租约，再形成终态。另一 Run 可在此前 Run 写终态元数据时开始；此时此前 Run 已无模型、工具或会话写入。不能安全收敛时报告 `session_not_quiescent` 并保留租约，不能假装已释放。
- 仅在记录的 PID 明确死亡、owner/nonce 重新核验一致后回收崩溃遗留的写锁和短锁。旧空锁、损坏 owner 或残留恢复 claim 会失败关闭，须先核验所有权；不按时间猜测失活或盲删锁。此机制面向支持 hardlink 的本机文件系统，不承诺共享网络文件系统或断电级持久性。

## 模型感知生命周期

- 每次请求按实际 Provider/model 解析 Context 窗口与输出上限；多个可信来源取安全交集，自定义端点缺少可信窗口时使用有明确 `assumed` 证据的保守值。
- 输入预算完整扣除本次实际 `maxTokens`、稳定前缀、工具 Schema、结构化输出、多模态占用、协议开销和安全余量。请求输出超过模型上限、图片占用未知或静态部分已经耗尽窗口时，会在 Provider 前失败关闭。
- 需要压缩时，Working Set 使用由 Runtime Facts 投影的 `TaskState` 替换旧前缀，并保留上一完整 user→assistant Turn 与当前未完成 user 消息。不可删除集合仍超预算时暂停，不做字符级截断。
- 每次压缩都把摘要和来源范围写入 Session，并把仅含指纹与父链的 Ledger Fact 写入运行事实。父链达到深度阈值后从 canonical Session 消息重建；损坏 lineage 不会被猜测修复。
- 受控 Artifact 在发送前重新验证路径、大小与 SHA-256。模型切换会重新预算；Provider 报告超窗时不会盲目重试同一请求。

## 错误与边界

- session_restore_failed：会话损坏时停止，不静默新建
- Session 最后一条 JSON 无法完整解析时，只移除未完成的尾部，保留已验证的 UTF-8 前缀和公开文件关联；重复打开仍可继续追加。中间损坏、完整前缀非法编码或冲突的公开路径仍会拒绝恢复，不静默覆盖。
- 旧 `ContextProtector` 压缩失败发出 `context_compaction_failed`；模型感知生命周期失败发出 `context_lifecycle_failed`，错误码为 `context_capability_conflict`、`context_budget_exhausted`、`context_artifact_missing` 或 `context_lineage_corrupt`
- 模型感知压缩必须绑定启用的持久化 Session；没有 Session 时只有无需压缩的请求可以继续，需要压缩的请求返回 `paused` 且不调用 Provider
- 成功解析预算发出 `context_budget_resolved`；成功压缩发出带 capability 指纹、lineage 深度、触发原因和 Session 条目引用的 `context_compacted`
- 摘要固定保留目标、约束、权限、已修改文件、测试状态和下一步
- 运行控制固定当前活动 Run；未绑定、收件箱未就绪、封口或 Run 身份错误会拒绝，不转投下一轮。同一 Run 的相同 controlId 重试不重复交付，冲突内容明确报告
- 控制五态回执与 `input_*` 消费/丢弃事实独立；applied 不等于已消费。仅 accepted 的控制可在冷恢复就绪后应用，applied 未确认消费者明确 discarded，不自动重投
- 暂停原输入继续遵守原恢复门；普通原输入已 discarded 仍不可恢复。控制丢弃不单独阻断安全暂停恢复，也不消除崩溃窗口或代替 Session/压缩正文，不能据此宣称恢复完整对话

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
- [packages/coremind-runtime/src/context-task-state.test.ts](../../../packages/coremind-runtime/src/context-task-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [运行控制真实恢复回归](../../../packages/coremind-runtime/src/control-runtime.acceptance.test.ts)
- [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-sessions/README.en.md)
- [Agent Skill](../../../skills/manage-sessions/SKILL.md)
