# Skill 与 SOP 装载上手指南

## 什么时候使用

把可复用的专业流程写成精简 Skill，并按 Agent 配置注入，业务事实仍由项目文档提供。

## 最小示例

```text
agents:
  reviewer:
    systemPrompt: 你是代码审查助手
    skills:
      - code-review
```

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
