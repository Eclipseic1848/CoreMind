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

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
