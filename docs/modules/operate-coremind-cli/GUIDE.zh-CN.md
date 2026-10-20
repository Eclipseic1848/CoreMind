# CLI 与 TUI 上手指南

## 什么时候使用

通过 create、run、chat、check、eval、doctor 和 templates 完成新手端到端开发路径，观察 Loop 状态，并用 run --resume 恢复暂停或意外中断运行。

## 最小示例

```powershell
coremind providers
coremind create my-agent --template translator --language typescript --provider alibaba-model-studio
Set-Location my-agent
coremind check coremind.yaml
```

在项目目录把 `.env.example` 复制为 `.env`，填入 `DASHSCOPE_API_KEY` 后，再运行 `coremind eval coremind.yaml`。CLI 从当前工作目录加载 `.env`。

readline 模式下，`/exit`、`!exit` 会先请求取消活动 Run，再等待收尾，与 TUI 一致。普通管道 EOF 仍让已开始的回答自然完成；空闲退出、审批及 MCP 登录等待沿用既有行为。取消不代表回滚已开始的工具副作用，仍须核对 Effect Receipt 与恢复检查。

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

## MCP 交互认证（1.1 开发线）

为 HTTP 服务配置 `oauth` 后，可在同一进程登录并执行：

```powershell
coremind run coremind.yaml --mcp-login remote --prompt '读取已授权资源'
```

CLI 先显示固定服务、授权方和 scope，再展示临时链接，由用户自行打开，不自动启动浏览器。Ctrl+C 在等待授权时取消并自然退出 130；EOF 同样取消。此模式需要 TTY，不能与 `--print`、`--json-events` 同用，避免混入机器输出或等待不存在的输入。

chat 的 Ink 与 readline 共用原输入所有者：`/mcp login remote` 开始、`/mcp cancel` 取消待定登录、`/mcp logout remote` 撤销本地使用权。认证命令不批准工具，待审批期间仍可取消或撤权。登录跨同一次 chat 的多个 Run 复用，退出会清理事务和监听；默认内存凭据重启即失效。没有独立的、退出即丢凭据的登录子命令。

认证链接只属于临时交互，不进入 Run Facts；不要将交互终端录制发布为业务日志。真实外部服务互通尚未验证；服务和存储限制见[配置指南](../../guide/02-configuration.md)。

## 自动化契约

以下示例使用 PowerShell 7 的 UTF-8 重定向；机器消费时分别保存 stdout JSONL 与 stderr 诊断。

```powershell
coremind run coremind.yaml --prompt "执行验收" --json-events 1> run-events.jsonl 2> run-errors.log
$LASTEXITCODE
Get-Content -LiteralPath run-events.jsonl -Encoding utf8 | Select-Object -Last 1
```

退出码按 `0/1/2/3/124/130` 判断终态，JSONL 最后一行必须能解析为 `type: "run_result"`；stderr 单独保存诊断。不要通过搜索自然语言“成功”来判断执行结果。

机器调用应优先读取最后一行的 `snapshot`。顶层兼容字段仍保留，但 `snapshot` 是 CLI、Worker 和两个 SDK 的同一纯 JSON 终态信封。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
