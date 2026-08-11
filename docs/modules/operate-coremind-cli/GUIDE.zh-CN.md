# CLI 与 TUI 上手指南

## 什么时候使用

通过 create、run、chat、check、eval、doctor 和 templates 完成新手端到端开发路径，观察 Loop 状态，并用 run --resume 恢复暂停或意外中断运行。

## 最小示例

```text
coremind create my-agent --template translator --language typescript
coremind check my-agent/coremind.yaml
coremind eval my-agent/coremind.yaml
```

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/operate-coremind-cli/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 在长回答生成期间输入 `/abort`，确认回答停止且可以继续输入。
6. 使用 `--session` 前设置 `session.enabled: true`；缺失时 CLI 必须明确失败，不能静默继续。
7. 使用显式 Loop 时确认 TUI、readline 和 `--json-events` 的状态顺序一致；暂停后以同一 runId 恢复。
8. 使用 `coremind doctor coremind.yaml` 时确认只检查该配置的 `provider.apiKeyEnv`，不会把无关 Provider 的密钥缺失当成失败。
9. 在 TUI 中依次运行 `/status`、`/artifacts`、`/context`，核对恢复、评测、完整产物引用和上下文压缩证据。

## 自动化契约

```powershell
coremind run coremind.yaml --prompt "执行验收" --json-events *> run-output.txt
$LASTEXITCODE
Get-Content -LiteralPath run-output.txt -Encoding utf8 | Select-Object -Last 1
```

正式脚本应分别重定向 stdout 与 stderr；上例只用于人工观察。退出码按 `0/1/2/3/124/130` 判断终态，JSONL 最后一行必须能解析为 `type: "run_result"`。不要通过搜索自然语言“成功”来判断执行结果。

机器调用应优先读取最后一行的 `snapshot`。顶层兼容字段仍保留，但 `snapshot` 是 CLI、Worker 和两个 SDK 的同一纯 JSON 终态信封。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
