# 模板与项目文档上手指南

## 什么时候使用

根据新建或已有工程生成语言匹配的代码骨架、测试、评测、双语文档、SOP 和项目 Skill，且不覆盖原文件。

## 最小示例

```text
coremind create . --template customer-triage
# 混合或空工程：
coremind create . --template customer-triage --language python --provider alibaba-model-studio
```

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/scaffold-coremind-projects/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
