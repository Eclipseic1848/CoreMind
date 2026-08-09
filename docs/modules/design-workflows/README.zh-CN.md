# Workflow 与显式有界 Loop

状态：release-candidate；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

本模块帮助没有 Loop Engineering 经验的开发者，在“固定编排”和“验证收敛”之间做正确选择，并让失败、暂停、恢复、重试和副作用都留下可检查证据。

| 方式 | 适用场景 | 框架保证 |
|---|---|---|
| 基础 Agent Loop | 单个 Agent 自主决定是否继续调用工具 | 共享预算、权限、Trace 和终态；不承诺业务质量收敛 |
| `workflow` | 步骤与依赖在运行前已经确定 | 顺序、并行、条件、有限重试与稳定步骤恢复 |
| `loop` | 必须执行“生成 → 验证 → 修复 → 再验证” | 显式状态、有界修复、无进展检测、暂停恢复和耗尽失败 |

`workflow` 与 `loop` 互斥。不要为了“更智能”而默认使用 Loop；固定规则应留在普通代码、工具或 Workflow 中。

## 公共接口与状态

- 配置：`LoopConfig`、`LoopActionConfig`、`LoopVerificationConfig`
- 执行：`LoopController`、`LoopRunner`、`Orchestrator`
- 恢复：`prepareRunResume`、`RunStateJournal`、`Effect Receipt`
- 状态：`planning`、`executing`、`verifying`、`repairing`、`paused`，以及成功、失败、中止、超时和预算耗尽终态

内部状态机依赖被封装在 `LoopController` 后方，不进入配置、协议或 SDK 公共合同。升级内部依赖时，必须重新运行状态迁移、快照恢复、取消传播和事件顺序测试。

## 可靠性与副作用边界

- verify 未通过时只能进入 repair、pause 或 fail，不能返回成功。
- `maxIterations`、`maxRepairs`、`maxRepeatedAction`、总预算和超时共同限制运行。
- 只有确认的 Provider/网络瞬态错误会重试；审批拒绝、安全拒绝、参数错误和确定性业务失败不盲目重试。
- 每次工具副作用记录 `started`、`committed` 或 `unknown` 收据。恢复时已提交副作用不重复执行，未知副作用先暂停并要求人工核对。
- 快照只表示 CoreMind 的稳定业务状态，不承诺恢复任意调用栈或正在进行的外部请求。
- `full` 只减少逐项审批，不关闭显式 deny、预算、Trace、checkpoint、收据或恢复检查。

## 源码、测试与示例

- [Loop 配置 Schema](../../../packages/coremind-config/src/schema/loop.ts)
- [LoopController](../../../packages/coremind-runtime/src/loop-controller.ts)
- [LoopRunner](../../../packages/coremind-runtime/src/loop-runner.ts)
- [重试分类](../../../packages/coremind-runtime/src/retry-policy.ts)
- [模块示例](../../../examples/modules/design-workflows/README.zh-CN.md)
- [验证修复黄金示例](../../../examples/golden/verified-repair-loop/README.zh-CN.md)
- [开发 SOP](SOP.zh-CN.md)
- [可复用 Skill](../../../skills/design-workflows/SKILL.md)

CoreMind 负责执行机制和质量证据；业务目标、验证规则、审批责任与最终验收仍由用户或业务负责人决定。
