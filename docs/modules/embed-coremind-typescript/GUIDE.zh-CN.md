# TypeScript SDK 上手指南

## 什么时候使用

通过 coremind-ai 单一门面在 Node 工程中嵌入 Runtime、工具、会话、显式 Loop、评测和事件。

## 最小示例

```text
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: '执行任务',
  toolDefinitions: [lookupOrder],
});
const result = await runtime.run();
if (result.outcome.status !== 'succeeded') {
  console.error(result.outcome.error?.message ?? result.outcome.finishReason);
}
```

`lookupOrder` 必须由 `defineTool` 创建，并包含例如 `effect: { operations: ['read'], reversible: true }` 的真实副作用声明。`run()` 的正常终态都通过返回值表达；只把配置加载、Runtime 创建或调用方自身错误放进 `catch`。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/embed-coremind-typescript/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对 `failed`、`paused`、`aborted`、`timeout`、`budget_exceeded` 分别写调用方分支测试。
6. 使用 `config.loop` 时收集 `loop_state`，验证暂停恢复不会重复完整步骤或 committed 副作用。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
