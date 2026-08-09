# CLI 与 TUI

状态：release-candidate；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

通过 create、run、chat、check、eval、doctor 和 templates 完成新手端到端开发路径，显示显式 Loop 当前状态，并用 run --resume 从安全边界恢复暂停或意外中断运行。

## 公共接口

- `coremind create`
- `coremind run --resume`
- `coremind chat`
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
- TUI 审批先显示副作用、完整目标与原因；长正文摘要，凭据字段隐藏
- TUI、readline 和 JSONL 显示相同的 `loop_state` 顺序；暂停以退出码 `2` 返回且可恢复
- 不安全或已结束的 runId 恢复会明确失败

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-cli/src](../../../packages/coremind-cli/src)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [模块示例](../../../examples/modules/operate-coremind-cli/README.zh-CN.md)
- [Module example](../../../examples/modules/operate-coremind-cli/README.en.md)
- [Agent Skill](../../../skills/operate-coremind-cli/SKILL.md)
