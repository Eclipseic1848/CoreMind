# CLI 与 TUI

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

通过 create、run、chat、check、eval、doctor 和 templates 完成新手端到端开发路径，并用 run --resume 从安全边界恢复未完成运行。

## 公共接口

- `coremind create`
- `coremind run --resume`
- `coremind chat`
- `coremind check`
- `coremind eval`
- `coremind doctor`
- `coremind templates`

## 错误与边界

- 命令失败返回非零退出码
- 非 TTY 审批安全拒绝
- TUI 与 readline 使用同一 ChatSession Harness
- 不安全或已结束的 runId 恢复会明确失败

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-cli/src](../../../packages/coremind-cli/src)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [模块示例](../../../examples/modules/operate-coremind-cli/README.zh-CN.md)
- [Module example](../../../examples/modules/operate-coremind-cli/README.en.md)
- [Agent Skill](../../../skills/operate-coremind-cli/SKILL.md)
