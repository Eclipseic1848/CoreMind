# 质量、Harness 与评测

CoreMind 把“模型返回了文字”与“运行成功、业务正确、可以发布”分成四层，避免新手把流畅回答误判为高质量 Agent。

## 1. 四个不同结论

```ts
const result = await runtime.run();

result.outcome;          // succeeded / failed / paused / aborted 与明确原因
result.metrics;          // 耗时、turn、step、工具、重试、token、费用
result.evaluation;       // 场景结果、业务评分、安全发现
result.releaseReadiness; // 是否可发布以及 blockers / warnings
```

一次 `RunOutcome.succeeded` 只说明这次机制执行完成，不代表业务正确，也不代表可以发布。没有运行场景评测时，`ReleaseReadiness` 会保留“尚未执行场景评测”阻塞项。

## 2. 多维预算

```yaml
runtime:
  maxTurns: 20
  maxSteps: 100
  stepTimeoutMs: 300000
  runTimeoutMs: 900000
  maxToolCalls: 50
  maxToolFailures: 3
  maxRetries: 3
  maxTokens: 100000
  maxCostUsd: 2
```

预算属于机制保护，不替用户决定 Agent 架构。超限会产生 `budget_exceeded` 事件并以明确错误结束，不能继续假装成功。Provider 没有提供 token 或费用时，相应指标保持未知，不伪造数值。

## 3. 权限、Trace 与 checkpoint

- `ask`：需要批准的操作逐项询问。
- `assisted`：工作区内低风险文件操作自动批准，高风险和网络操作按策略询问。
- `full`：不逐项询问，但显式 deny、Trace、checkpoint 和审计仍然启用；路径感知文件工具继续执行工作区策略。

每个 Trace 事件包含 `runId`、`eventId`、严格递增的 `sequence` 和时间戳。RunState 使用 append-only JSONL 保存开始、事件、checkpoint 与结束证据。

`edit/write` 在修改前保存文件快照，可计算 diff 并显式恢复。Linux 的内置 `bash` 使用 OS 级沙箱，当前固定断网、只允许写工作区，初始化失败时关闭执行且不回退宿主 shell。Windows 没有 OS 级 shell 沙箱；shell 和任意自定义工具只标记为不可自动回退。CoreMind 不会伪造完整恢复保证。

Linux 实现锁定 [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) `0.0.71` 并依赖 [Bubblewrap](https://github.com/containers/bubblewrap)。前者官方仍标注为 Beta Research Preview，因此它是当前 Alpha 的纵深防御实现，不是生产成熟度或 Claude Code 等价性的证据。Linux CI 必须实际执行越界写入和联网失败测试。

Ubuntu/Debian 需要安装 `bubblewrap`、`socat` 和 `ripgrep`。Ubuntu 24.04 及以后默认的 AppArmor 非特权用户命名空间限制会阻止这套隔离机制；当前 CI 仅在临时 runner 中关闭该限制。生产机器不得照抄 CI 设置，必须由系统安全负责人评估后决定启用方式；无法满足前置条件时，CoreMind 会关闭 Linux `bash` 执行，而不是降级到宿主 shell。

## 4. Context 与 Session

- `--session <id>` 保存并恢复多轮消息；损坏会话会返回 `session_restore_failed`，不会静默创建新会话。
- 每轮 Chat 都是完整 Harness Run，TUI 与无头运行使用相同预算、权限、Trace 和 checkpoint。
- Provider 调用前按 turn 边界做确定性 Context 保护，并产生 `context_compacted` 事件。
- `session.compact` 是持久会话的可选 LLM 摘要；Loop 内 Context 保护不依赖它。

## 5. 三档质量级别

```yaml
quality:
  profile: standard
  minScenarioPassRate: 1
  allowOverride: true
```

- `development`：基础检查，缺失开发材料记为告警。
- `standard`：默认；配置、安全、权限和项目材料作为发布前错误。
- `strict`：每个评测场景至少重复 3 次，暴露不稳定结果。

安全错误（例如明文 API key、关闭工作区边界）不可覆盖。非安全错误只有在 `allowOverride: true` 且提供 `--override-reason` 时才能覆盖，并把原因、时间、质量档和错误码追加写入 `.coremind/quality-overrides.jsonl`。审计文件写入失败时，覆盖本身失败。

## 6. 静态门禁

```bash
coremind check coremind.yaml
coremind check coremind.yaml --profile strict
coremind check coremind.yaml --override-reason "仅用于已隔离的短期原型"
coremind check coremind.yaml --json
```

`check` 验证 Config v2、安全设置、预算/权限是否明确，以及脚手架要求的中英文需求、架构、SOP、测试指南、验收清单、评测文件、项目 Skill 和决策记录。

## 7. 场景评测

`evals/scenarios.yaml`：

```yaml
schemaVersion: 1
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    expected:
      outcome: succeeded
      contains:
        - 已支付
      notContains:
        - TODO
```

运行：

```bash
coremind eval coremind.yaml
coremind eval coremind.yaml --suite evals/regression.yaml --json
```

每次尝试都使用真实 `CoreMindRuntime`。模型异常、工具失败导致的运行异常和业务断言失败都会进入报告。交互终端可以处理 ask 审批；非 TTY 环境安全拒绝，CI 应为已审查工具写明确 allow，或显式选择符合风险边界的权限模式。

## 8. Workflow 重试

```yaml
workflow:
  - id: review
    type: call
    agent: reviewer
    input: "审查：{{draft.text}}"
    saveAs: review
    retry:
      max: 2
      if: "{{text}} contains INCOMPLETE"
```

`retry.max` 是步骤局部上限，`runtime.maxRetries` 是全局上限。全局耗尽会明确中止；步骤局部次数耗尽但未超过全局上限时，会保留最后输出并发出质量告警，因此必须用场景评测决定它是否可接受。

## 9. 中断恢复与幂等边界

每个运行把事件和完整步骤输出追加写入 `.coremind/runs/<runId>.jsonl`。进程意外中断后，可以从最后一个完整稳定边界继续：

```bash
coremind run coremind.yaml --resume <runId>
```

恢复使用原 runId，延续 Trace sequence、预算、重试计数和原始输入，并复用已完成步骤的 `step_output`。以下情况会明确拒绝，不会猜测或重放：

- RunState 已正常结束或已记录失败/中止结论。
- JSONL 损坏、sequence 不连续，或当前配置指纹与原运行不一致。
- 调用方提供了不同输入。
- 未完成步骤已经调用 `edit`、`write`、`bash`、自定义工具等非重放安全能力。

工具事件带有幂等关联标识，方便业务工具记录收据或做去重；它不是通用的“恰好一次执行”承诺。涉及订单、支付、消息发送等副作用时，业务工具必须在自己的持久层实现幂等，并为重复调用写测试。

## 10. 推荐验收顺序

1. 为业务正常、边界、失败、权限拒绝和预算超限写场景。
2. 运行单元/集成测试。
3. 运行 `coremind check`。
4. 运行 `coremind eval`，strict 项目检查重复稳定性。
5. 检查 Trace、预算、审批、checkpoint/diff 与失败原因。
6. 由业务负责人确认结果；只有 `ReleaseReadiness.ready` 且人工门禁完成后才进入发布。

可直接参考 [评测模块](../modules/evaluate-agents/README.zh-CN.md) 与 [四个黄金示例](../../examples/golden/README.zh-CN.md)。
