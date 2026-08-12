# Session 与 Context

状态：`0.3.0-rc.2` 发布候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

保存多轮消息、严格恢复损坏错误，并在 Provider 调用前进行确定性的上下文保护。

## 公共接口

- `CoreMindSession`
- `ChatSession`
- `ContextProtector`

## 错误与边界

- session_restore_failed：会话损坏时停止，不静默新建
- 上下文压缩保留最近完整轮次并产生事件；失败发出 `context_compaction_failed`，不会静默截断
- 摘要固定保留目标、约束、权限、已修改文件、测试状态和下一步

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/session.ts](../../../packages/coremind-runtime/src/session.ts)
- [packages/coremind-runtime/src/chat-session.ts](../../../packages/coremind-runtime/src/chat-session.ts)
- [packages/coremind-runtime/src/context.ts](../../../packages/coremind-runtime/src/context.ts)
- [packages/coremind-runtime/src/session.test.ts](../../../packages/coremind-runtime/src/session.test.ts)
- [packages/coremind-runtime/src/chat-session.test.ts](../../../packages/coremind-runtime/src/chat-session.test.ts)
- [packages/coremind-runtime/src/context.test.ts](../../../packages/coremind-runtime/src/context.test.ts)
- [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-sessions/README.en.md)
- [Agent Skill](../../../skills/manage-sessions/SKILL.md)
