# 配置与 Schema示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

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

增加自定义脚本工具时，使用下面的结构声明副作用：

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

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。

返回 [中文指南](../../../docs/modules/configure-coremind/GUIDE.zh-CN.md)。
