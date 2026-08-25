# 质量、Harness 与评测

CoreMind 把“模型返回了文字”与“运行成功、业务正确、可以发布”分成四层，避免新手把流畅回答误判为高质量 Agent。

## 1. 四个不同结论

```ts
const result = await runtime.run();

result.outcome;          // succeeded / failed / paused / aborted / timeout / budget_exceeded
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

Trace 事件在持久化或转发前会递归脱敏密钥、Token、口令、认证头、Cookie、私钥、URL 敏感参数和命令中的敏感值；正文只留长度标记，普通测试命令仍可审查。这不代替操作系统访问控制，会话与非敏感 Trace 上下文仍应按业务数据管理。

`edit/write` 在修改前保存文件快照，可计算 diff 并显式恢复。恢复时还会比较工具完成后的文件指纹；用户或并发进程后来修改过文件时，CoreMind 会报告 `checkpoint_conflict` 并拒绝覆盖。Linux 的内置 `bash` 使用 OS 级沙箱，当前固定断网、只允许写工作区，初始化失败时关闭执行且不回退宿主 shell。Windows 没有 OS 级 shell 沙箱；宿主 Shell 只有在 full、`workspaceOnly: false`、`network: allow` 同时选择时开放，其他组合失败关闭。Git Bash 发现不改变这一安全边界。

TypeScript、Python 与脚本自定义工具都必须声明 `effect.operations` 和 `effect.reversible`；非标准嵌套路径或 URL 用 `pathFields`、`urlFields` 标记。权限层不依据工具名称猜测未知副作用，自定义工具也不能冒用内置工具名。

Linux 实现锁定 [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) `0.0.71` 并依赖 [Bubblewrap](https://github.com/containers/bubblewrap)。前者官方仍标注为 Beta Research Preview，因此当前将其作为纵深防御实现。Linux CI 必须实际执行越界写入和联网失败测试，安全结论以完整权限策略、恢复机制和自动化证据为准。

Ubuntu/Debian 需要安装 `bubblewrap`、`socat` 和 `ripgrep`。Ubuntu 24.04 及以后默认的 AppArmor 非特权用户命名空间限制会阻止这套隔离机制；当前 CI 仅在临时 runner 中关闭该限制。生产机器不得照抄 CI 设置，必须由系统安全负责人评估后决定启用方式；无法满足前置条件时，CoreMind 会关闭 Linux `bash` 执行，而不是降级到宿主 shell。

## 4. Context 与 Session

- `--session <id>` 保存并恢复多轮消息；损坏会话会返回 `session_restore_failed`，不会静默创建新会话。
- 每轮 Chat 都是完整 Harness Run，TUI 与无头运行使用相同预算、权限、Trace 和 checkpoint。
- Provider 调用前按 turn 边界做确定性 Context 保护，并产生 `context_compacted` 事件。
- `session.compact` 是持久会话的可选 LLM 摘要；Loop 内 Context 保护不依赖它。压缩失败会发出 `context_compaction_failed`，不会静默退化；摘要固定保留目标、约束、权限、已修改文件、测试状态和下一步。

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

需要验证工具轨迹、测试命令、文件、差异和运行状态时，使用 schemaVersion 2。它要求至少一个 `outcome` grader，同一场景最多 20 个 grader；schemaVersion 1 继续用于兼容简单文本断言。

```yaml
schemaVersion: 2
scenarios:
  - id: repair-discount
    input: 复现并修复折扣计算错误
    repetitions: 3
    graders:
      - { id: outcome, type: outcome, status: succeeded }
      - type: trajectory
        sequence:
          - { tool: bash, result: failed }
          - { tool: read, result: succeeded }
          - { tool: edit, result: succeeded }
          - { tool: bash, result: succeeded }
        maxToolFailures: 1
      - type: command
        command: node
        args: ["--test"]
      - type: file
        path: src/discount.ts
        contains: ["Math.min"]
      - type: diff
        requiredPaths: ["src/discount.ts"]
        allowedPaths: ["src/discount.ts"]
        preserveExisting: true
      - type: state
        maxTurns: 12
        maxSecurityFindings: 0
      - type: response
        contains: ["src/discount.ts", "测试"]
```

`command` grader 使用命令与参数数组，不经过 Shell 拼接；`file` 与 `diff` 路径限制在工作区内。评测开始前会记录受保护文件和脏工作区基线，默认拒绝覆盖用户已有未提交内容。首次缺陷测试失败可以是预期复现证据，它计入工具失败指标，但不能被误记为安全漏洞。

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

`retry.max` 是步骤局部上限，`runtime.maxRetries` 是全局上限。只要重试条件仍判定输出不合格，任一上限耗尽都会以 `retry_exhausted` 明确失败；Runtime 不再接受已知不合格的最后输出。

## 9. 显式验证修复 Loop

`workflow` 适合固定依赖；需要“生成 → 验证 → 修复 → 再验证”时，使用公开 `loop` 配置。Loop 只有 verify 的 `passIf` 通过后才成功，并受最大迭代、最大修复、重复动作、预算和超时共同约束。

```yaml
loop:
  execute: { agent: coder, input: "{{prompt}}" }
  verify:
    agent: reviewer
    input: "{{candidate.text}}"
    passIf: "{{text}} == PASS"
  repair: { agent: coder, input: "{{verification.text}}" }
  maxIterations: 3
  maxRepairs: 2
  maxRepeatedAction: 2
  onFailure: repair
  onExhausted: fail
```

Provider/网络错误只有经统一分类确认为瞬态时才重试。第一次人工审批拒绝会阻断被拒绝项和本批次尚未审批的后续工具，本批结果归并后暂停运行，不会回灌模型继续请求审批；顺序工作流不会保存拒绝步骤的输出，也不会进入后续步骤。安全策略拒绝同样暂停。参数错误与确定性业务失败直接失败；中止和超时会传播到 Loop 控制器并留下同名终态。TUI、无头 CLI、TypeScript SDK 和 Python SDK 观察同一状态序列。

## 10. 中断、暂停恢复与 Effect Receipt

每个运行把事件、Loop 稳定快照和完整步骤输出追加写入 `.coremind/runs/<runId>.jsonl`。进程意外中断或 Loop 显式暂停后，可以从最后一个完整稳定边界继续：

```bash
coremind run coremind.yaml --resume <runId>
```

恢复使用原 runId，延续 Trace sequence、预算、重试计数、Loop 快照和原始输入，并复用已完成步骤的 `step_output`。以下情况会明确拒绝，不会猜测或重放：

- RunState 已正常结束或已记录失败/中止结论。
- JSONL 损坏、sequence 不连续，或当前配置指纹与原运行不一致。
- 调用方提供了不同输入。
- 未完成步骤存在 `unknown` 副作用，尚未由人工完成核对。

工具调用生成稳定幂等关联标识，并记录 `started`、`committed` 或 `unknown` Effect Receipt。恢复时，完整步骤与已提交副作用不会自动重放；`started` 或 `unknown` 会进入人工核对，而不是猜测执行结果。这仍不是通用的“恰好一次执行”承诺。涉及订单、支付、消息发送等外部副作用时，业务工具必须在自己的持久层实现幂等、收据或补偿流程，并为重复调用写测试。

## 11. 源码与发布物门禁

源码贡献和候选发布必须验证“测试能过”之外的内容：

```bash
npm run test:stability
npm run test:coverage
npm run release:check-npm
npm run release:test-npm
npm run release:test-source
npm run build:python-worker
python -X utf8 -m build --wheel python
python -X utf8 -m twine check python/dist/*
npm run release:check-wheel
npm run acceptance:rc
npm run docs:audit
```

`test:stability` 以单 Worker 连续运行三次全量测试，避免多个真实子进程用例争抢宿主资源；任何一轮失败立即阻断。Vitest 多项目模式不会把根级超时可靠下传到每个独立项目，因此长链路 Runtime 测试在自身项目配置中显式使用 15 秒 Harness 上限，CLI 子进程测试使用 30 秒；两者都不改变产品运行预算。`test:coverage` 使用 V8 记录全仓和关键 Runtime 文件的真实覆盖率。Windows 与 Linux 会运行不同的平台安全测试，因此分别锁定全仓不下降基线：Windows 为 lines 72.82%、statements 70.80%、functions 80.32%、branches 63.30%；Linux 为 lines 73.26%、statements 71.19%、functions 81.00%、branches 63.23%，均来自对应目标平台的候选实测。通用回退基线取两种正式平台的逐项最小值，不能比任一正式平台更宽松。关键 Runtime 文件继续使用跨平台共同底线，其中 ToolPolicy 分支底线为 86.23%。Windows Shell 能力探测使用注入式确定性用例，集成测试显式传入最小环境，属性测试固定随机种子，并以独立回归覆盖关键权限分支，避免机器环境和随机样本造成覆盖率漂移。当前仍低于全仓 80% 与关键分支 90% 长期目标，因此门禁持续报告差距，不把基线写成目标已达成。

npm 门禁逐包执行实际 `npm pack`，拒绝测试、内部计划、运行状态、checkpoint、临时文件和凭据进入 tarball，再用 publint、类型解析和全新项目安装验证公共入口。源码 ZIP 门禁使用临时 Git 索引生成当前候选快照，不改变真实暂存区；跨平台 ZIP 解码器在解压前检查文件清单并拒绝路径穿越，随后在干净目录执行安装、构建、合同检查和 CLI 启动。wheel 门禁检查内容与元数据，安装到全新虚拟环境，并实际启动内置 Worker。

Windows 与 Linux 必须分别保留三连跑结果。GitHub Actions 可提供 Linux 自动化证据，但真实 TUI 仍需目标平台 TTY 人工验收。

Release Candidate 另按[RC 验收指南](../release/RC-ACCEPTANCE.zh-CN.md)执行 P01～P20。P01～P19 必须同时有自动套件与精确测试标题锚点；P20 必须保留绑定同一版本和提交的 Windows/Linux 真实伪终端证据。真实 Provider 当次复验和目标平台 CI 是独立门禁，不能由自动矩阵代替。

## 12. 推荐验收顺序

1. 为业务正常、边界、失败、权限拒绝和预算超限写场景。
2. 运行单元/集成测试。
3. 运行 `coremind check`。
4. 运行 `coremind eval`，strict 项目检查重复稳定性。
5. 检查 Trace、预算、审批、checkpoint/diff 与失败原因。
6. 由业务负责人确认结果；只有 `ReleaseReadiness.ready` 且人工门禁完成后才进入发布。

可直接参考 [评测模块](../modules/evaluate-agents/README.zh-CN.md)、[5 个黄金示例](../../examples/golden/README.zh-CN.md)与[编码智能体真实缺陷评测](../../examples/coding-evals/README.zh-CN.md)。
