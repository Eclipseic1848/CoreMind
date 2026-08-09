# CLI 与 TUI示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
coremind create my-agent --template translator --language typescript
coremind check my-agent/coremind.yaml
coremind eval my-agent/coremind.yaml
coremind run my-agent/coremind.yaml --prompt "验收" --json-events
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 检查 JSONL 最后一行是 `run_result`，并分别验证成功 `0`、失败 `1`、暂停 `2`、预算 `3`、超时 `124`、中止 `130`。
6. 同时传入 `--print --json-events`，确认 CLI 在模型调用前明确报错且退出码为 `1`。

返回 [中文指南](../../../docs/modules/operate-coremind-cli/GUIDE.zh-CN.md)。
