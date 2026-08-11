# Trace、RunState 与调试

状态：\`0.3.0-rc.1\` 发布候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用带 runId、eventId、sequence 和 timestamp 的脱敏事件及 append-only RunState 保存可复核证据，包括 Loop 稳定快照与 Effect Receipt，并生成安全恢复计划。

## 公共接口

- `TraceRecorder`
- `RunStateJournal`
- `FileRunStore`
- `CoreMindEvent`
- `prepareRunResume`
- `LoopControllerSnapshot`

## 错误与边界

- 损坏或断序 JSONL 会报告 run_state_corrupt
- 已结束运行不可重复恢复
- 配置指纹、输入或 unknown 副作用不匹配时拒绝恢复
- 事件严格递增，Loop 状态、审批、预算、Effect Receipt 和 checkpoint 进入同一 Trace
- Trace/RunState 持久化前隐藏凭据字段、正文、命令中的敏感参数和 URL 密钥；路径与非敏感测试命令仍可审计

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/trace.ts](../../../packages/coremind-runtime/src/trace.ts)
- [packages/coremind-runtime/src/run-state.ts](../../../packages/coremind-runtime/src/run-state.ts)
- [packages/coremind-runtime/src/events.ts](../../../packages/coremind-runtime/src/events.ts)
- [packages/coremind-runtime/src/run-state.test.ts](../../../packages/coremind-runtime/src/run-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [packages/coremind-runtime/src/trace.test.ts](../../../packages/coremind-runtime/src/trace.test.ts)
- [模块示例](../../../examples/modules/inspect-agent-traces/README.zh-CN.md)
- [Module example](../../../examples/modules/inspect-agent-traces/README.en.md)
- [Agent Skill](../../../skills/inspect-agent-traces/SKILL.md)
