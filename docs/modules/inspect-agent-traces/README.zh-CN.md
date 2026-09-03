# Trace、RunState 与调试

状态：随 `0.7.0` 稳定版发布；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用带 runId、eventId、sequence 和 timestamp 的脱敏事件及 append-only RunState 保存可复核证据，包括 Loop 稳定快照、Effect Receipt、Context 工作集指纹和 Provider 请求指纹；从同一 Fact Projection 生成安全恢复、本地观测与确定性离线重放结果。

## 公共接口

- `TraceRecorder`
- `RunStateJournal`
- `FileRunStore`
- `CoreMindEvent`
- `prepareRunResume`
- `LoopControllerSnapshot`
- `projectLocalObservability`
- `ReplayKit`
- `TelemetryEgressController`

## 错误与边界

- 损坏或断序 JSONL 会报告 run_state_corrupt
- 已结束运行不可重复恢复
- 配置指纹、输入或 unknown 副作用不匹配时拒绝恢复
- 事件严格递增，Loop 状态、审批、预算、Effect Receipt 和 checkpoint 进入同一 Trace
- Trace/RunState 持久化前隐藏凭据字段、正文、命令中的敏感参数和 URL 密钥；路径与非敏感测试命令仍可审计
- `ReplayKit` 只消费固定 Facts 与实际 Provider Working Set fixture，不调用 Provider 或工具；fixture 与持久请求指纹不一致时报告 `run_state_corrupt`
- 本地观测始终显性；Telemetry 默认 `DISABLED`。进程外发送必须同时匹配持久配置、用户 consent 和受信任 Adapter 返回的精确 origin 出站收据
- Core 只校验出站收据的 origin、解析地址、redirect/proxy deny、TLS strict 与指纹，不能自行证明 Adapter 实际执行了 DNS/TLS/网络策略；`handed_off` 也不等于接收端 delivered

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/trace.ts](../../../packages/coremind-runtime/src/trace.ts)
- [packages/coremind-runtime/src/run-state.ts](../../../packages/coremind-runtime/src/run-state.ts)
- [packages/coremind-runtime/src/events.ts](../../../packages/coremind-runtime/src/events.ts)
- [packages/coremind-runtime/src/observability.ts](../../../packages/coremind-runtime/src/observability.ts)
- [packages/coremind-runtime/src/replay-kit.ts](../../../packages/coremind-runtime/src/replay-kit.ts)
- [packages/coremind-runtime/src/run-state.test.ts](../../../packages/coremind-runtime/src/run-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [packages/coremind-runtime/src/trace.test.ts](../../../packages/coremind-runtime/src/trace.test.ts)
- [packages/coremind-runtime/src/observability.test.ts](../../../packages/coremind-runtime/src/observability.test.ts)
- [packages/coremind-runtime/src/replay-kit.test.ts](../../../packages/coremind-runtime/src/replay-kit.test.ts)
- [packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx](../../../packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx)
- [模块示例](../../../examples/modules/inspect-agent-traces/README.zh-CN.md)
- [Module example](../../../examples/modules/inspect-agent-traces/README.en.md)
- [Agent Skill](../../../skills/inspect-agent-traces/SKILL.md)
