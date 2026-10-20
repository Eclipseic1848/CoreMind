# CLI 与 TUI

状态：合同与文档已对齐 `1.0.0` 发布线；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

通过 create、run、chat、check、eval、doctor 和 templates 完成新手端到端开发路径，显示显式 Loop 当前状态，并用 run --resume 从安全边界恢复暂停或意外中断运行。

## 公共接口

- `coremind create`
- `coremind run --resume`
- `coremind chat`
- chat 内 `/steer 文本`、`/follow-up 文本`（1.1 开发线，同一活动 Run）
- `coremind check`
- `coremind eval`
- `coremind doctor`
- `coremind templates`

## 错误与边界

- `run` 稳定退出码：成功 `0`、失败 `1`、暂停 `2`、预算耗尽 `3`、超时 `124`、中止 `130`
- `--json-events` 的 stdout 只含 JSONL，最后一行固定为 `run_result`；诊断写入 stderr
- `--print` 与 `--json-events` 互斥，防止自然语言污染机器输出
- 非 TTY 审批安全拒绝
- TUI 与 readline 使用同一 ChatSession Harness；失败终态会显示原因，不会静默结束
- readline 的 `/exit`、`!exit` 与 TUI 一致，先请求取消活动 Run 并等待收尾。普通管道 EOF 仍等待已开始的回答自然完成；空闲退出、审批和 MCP 登录等待的既有行为保持不变。
- TUI 忙时保留一份可编辑草稿，Enter 不提交普通输入；空闲后 Enter 确认。readline 保留第一份忙时草稿，后续输入提示未保存，不覆盖或自动执行；空闲后预填编辑并确认，未预填时用空行确认原稿
- TUI 与 readline 均支持 `/steer 文本`、`/follow-up 文本`；空正文只显示用法。控制只交给调用时的活动 Run，未就绪、封口或错误 Run 明确拒绝；两入口的 `/abort` 与 TUI 的 `/children` 仍可用
- 工具审批期显式控制不会批准工具；TUI 先按 `/` 进入命令模式、Esc 返回审批，命令正文 y/n 不作审批答案。权限模式和 deny 等边界不变
- 五态控制回执不等于消费；独立 `input_*` 显示认领/完成/丢弃。迟到回执标明原 Run/controlId，不清除后来草稿；控制不创建并发 Run
- TUI 审批先显示副作用、完整目标与原因；长正文摘要，凭据字段隐藏
- TUI、readline 和 JSONL 显示相同的 `loop_state` 顺序；暂停以退出码 `2` 返回且可恢复
- 不安全或已结束的 runId 恢复会明确失败
- TUI 的 `/status`、`/artifacts` 与 `/context` 显示恢复、评测、Artifact、缓存和压缩状态
- JSONL 最后一条 `run_result.snapshot` 与 TypeScript/Python SDK 使用同一纯 JSON 快照

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-cli/src](../../../packages/coremind-cli/src)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [readline 控制与草稿](../../../packages/coremind-cli/src/commands/chat.ts)及[回归](../../../packages/coremind-cli/src/commands/chat.test.ts)
- [TUI](../../../packages/coremind-cli/src/tui.tsx)、[回归](../../../packages/coremind-cli/src/tui.test.tsx)与[真实终端验收脚本](../../../scripts/tty-acceptance.mjs)
- [模块示例](../../../examples/modules/operate-coremind-cli/README.zh-CN.md)
- [Module example](../../../examples/modules/operate-coremind-cli/README.en.md)
- [Agent Skill](../../../skills/operate-coremind-cli/SKILL.md)
