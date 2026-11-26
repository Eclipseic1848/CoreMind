# 配置与 Schema示例

## 只启用 Runtime

按[2.1.0 安装说明](../../../docs/migrations/2.0-to-2.1.zh-CN.md)安装 CLI 和所需 SDK。在业务目录执行 `npx --no-install coremind create . --runtime-only --provider deepseek --model deepseek-flash`，按所选模型设置凭据。也可直接使用[最小配置](../../../docs/guide/06-capability-construction.md)。

- CLI：`coremind run coremind.yaml --prompt "请只回答 OK"`。
- TypeScript：运行 `npm install --save-exact coremind-ai@2.1.0`，把 [runtime-only.mts](runtime-only.mts) 复制到项目根目录，再运行 `node runtime-only.mts`。
- Python：运行 `python -m pip install coremind-ai==2.1.0`，把 [runtime_only.py](runtime_only.py) 复制到根目录。用 `python runtime_only.py` 或 `python runtime_only.py --async` 验证同步和异步入口。

四个入口均应完成一轮回复。检查模型请求的工具目录为空，并确认业务目录只需基础配置与运行所需的依赖。

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

公开 `0.8.0` 的 Loop 也支持 `verify.mode: host`，由宿主持久提交验收决定，不设置 `passIf`；配置和离线演示见[宿主验收示例](../../host-verification/README.md)。

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。

返回 [中文指南](../../../docs/modules/configure-coremind/GUIDE.zh-CN.md)。
