# TypeScript SDK

状态：合同与文档已对齐 `1.0.0` 发布线；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

通过 coremind-ai 单一门面在 Node 工程中嵌入 Runtime、工具、会话、显式 Loop、评测和事件。

## 公共接口

- `CoreMindRuntime`
- `ChatSession`
- `ChatSession.steer(message, options?)` / `followUp(message, options?)`（1.1 开发线，`options` 为 `{ controlId?, runId? }`）
- `defineTool`
- `checkProject`
- `runEvaluationSuite`
- `LoopConfig` / `LoopPhase`
- `RunSnapshot` / `createRunSnapshot`
- `onVerification` 候选通知与 `runtime.acceptControl` 持久宿主验收
- 生命周期扩展与轻量实验公共接口

## 错误与边界

- `runtime.run()` 与 `ChatSession.chat()` 通过 `RunResult.outcome` 返回失败、暂停、中止、超时和预算耗尽，不要求调用方用异常判断运行终态
- 创建/配置等运行前错误仍使用 `CoreMindError.code`
- `defineTool` 必须提供结构化 `effect` 副作用声明
- `loop_state`、RunOutcome、稳定快照和 Effect Receipt 与 CLI/Python 共用同一 Runtime 语义
- 库门面只 re-export，不复制业务逻辑
- `RunResult.snapshot` 是纯 JSON；Protocol 会对终态、指标、Trace、Checkpoint、Artifact 和扩展收据执行完整嵌套校验，拒绝跨语言结构漂移
- 宿主验收中 `onVerification` 的返回值不会放行；控制回执 `accepted` 或 `applied` 都不能替代最终 Run outcome
- 会话控制固定调用时的实际活动 Turn Runtime；未绑定、收件箱未就绪、已封口或 Run 身份错误会拒绝，不会转投下一轮。同一 Run 重试保留同一 controlId；同内容重复为 duplicate，不同内容为 conflict
- `accepted/applied/rejected/duplicate/conflict` 是控制回执；消费与丢弃由独立 `input_*` 事件表达。控制不扩展权限，也不启动并发 Run
- 冷恢复可继续 accepted 控制；已 applied 但未确认消费者只明确 discarded，不自动重投。暂停原输入仍按原门恢复，普通已 discarded 输入仍不可恢复；不承诺绝对 exactly-once 或恢复完整对话

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind/src/index.ts](../../../packages/coremind/src/index.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [ChatSession 控制](../../../packages/coremind-runtime/src/chat-session.ts)、[活动绑定](../../../packages/coremind-runtime/src/active-run-binding.ts)与[真实控制恢复回归](../../../packages/coremind-runtime/src/control-runtime.acceptance.test.ts)
- [模块示例](../../../examples/modules/embed-coremind-typescript/README.zh-CN.md)
- [Module example](../../../examples/modules/embed-coremind-typescript/README.en.md)
- [Agent Skill](../../../skills/embed-coremind-typescript/SKILL.md)
