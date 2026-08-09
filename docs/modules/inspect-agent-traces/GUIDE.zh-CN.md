# Trace、RunState 与调试上手指南

## 什么时候使用

用带 runId、eventId、sequence 和 timestamp 的事件及 append-only RunState 保存可复核证据，并生成安全恢复计划。

## 最小示例

```text
runtime = await CoreMindRuntime.create({
  config,
  configDir,
  trace: (entry) => console.log(entry.sequence, entry.event.type),
});
```

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/inspect-agent-traces/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 显式 Loop 还要核对 `loop_state` 顺序、最新稳定快照和每个副作用的 started/committed/unknown 收据。
6. 使用只存在于测试环境的假凭据和正文运行一次工具，确认 Trace 与 RunState 中只保留隐藏标记、目标路径和非敏感审计信息。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要为了调试关闭 Trace 脱敏；需要原始业务数据时应在业务系统内按其访问控制单独查看。
