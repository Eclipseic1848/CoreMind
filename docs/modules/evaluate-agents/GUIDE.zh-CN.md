# 测试、评测与质量门禁上手指南

## 什么时候使用

分离运行成功、指标、业务评测和发布判断，并用可重复场景阻止失败伪装成通过。

## 最小示例

```text
schemaVersion: 1
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    expected:
      contains:
        - 已支付
      notContains:
        - TODO
```

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/evaluate-agents/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
