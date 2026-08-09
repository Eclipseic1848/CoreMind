# 配置与 Schema 上手指南

## 什么时候使用

用一份可校验的 coremind.yaml 描述 Agent、工具、Workflow 或显式 Loop、预算、权限和质量档。

## 最小示例

```text
schemaVersion: 2
name: support-agent
agents:
  main:
    systemPrompt: 你是客服助手
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
runtime:
  maxTurns: 12
quality:
  profile: standard
```

自定义脚本工具还要声明可检查的副作用：

```yaml
agents:
  main:
    tools:
      - path: tools/save-report.mjs
        effect:
          operations: [write]
          reversible: true
          pathFields: [output.path]
```

`pathFields` 和 `urlFields` 支持点号路径。它们必须指向调用参数中的真实字段；不可逆的外部系统操作不要标记为 `reversible: true`。自定义工具不得使用 `read`、`write`、`bash` 等内置工具名。

需要独立验证与有限修复时，增加 `loop.execute`、`loop.verify.passIf`、`loop.repair` 和所有边界字段；不要同时配置 `workflow`。完整配置见[显式 Loop 指南](../design-workflows/GUIDE.zh-CN.md)。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/configure-coremind/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 使用 Loop 时运行验证修复黄金示例，并覆盖暂停恢复与耗尽失败。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要遗漏或虚构自定义工具的 `effect`；无法描述副作用时先拆小工具边界。
