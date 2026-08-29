# 配置指南

`coremind.yaml`（也支持 JSON）是智能体的唯一定义文件。本指南按字段逐个说明。

## 顶层字段

```yaml
schemaVersion: 2        # 配置格式版本（当前固定 2）
name: my-agent          # 必填：智能体名称
description: 一句话说明
provider: {...}         # 模型提供商（缺省 deepseek）
options: {...}          # 全局模型选项（temperature 等）
tools: [...]            # 全局默认工具（agent 未单独配置时继承）
agents: {...}           # 必填：至少一个智能体
defaultAgent: 名称       # 缺省取第一个
workflow: [...]         # 可选：编排步骤（缺省时单 agent 直答）
loop: {...}             # 可选：显式生成/验证/修复闭环；与 workflow 互斥
session: {...}          # 可选：会话持久化
runtime: {...}          # 可选：turn/step/工具/重试/token/费用/超时预算
permissions: {...}      # 可选：ask / assisted / full 与路径/网络策略
quality: {...}          # 可选：development / standard / strict
telemetry: {...}        # 可选：进程外投影；默认 DISABLED，本地观测不受影响
```

未知字段会告警但**不会报错**——写错字段也能跑，只是会提示。

## provider：模型提供商

```yaml
provider:
  id: deepseek                  # 内置提供商之一
  model: deepseek-v4-flash      # 可选，缺省取该提供商默认模型
  apiKeyEnv: MY_DS_KEY          # 可选：自定义 API key 环境变量名（缺省按 id 推断）
```

**内置提供商**：动态继承锁定运行时依赖的全部 Provider。`0.2.0-rc.1` 为 37 个继承入口；`0.3.0-rc.2` 与当前 `0.3.0` 稳定版均为 39 个继承入口，加上 CoreMind 原生入口共 40 个可配置 Provider。可通过 TypeScript SDK 的 `listInheritedProviders()` 查看当前安装版本的准确清单。继承支持不等于真实认证；没有当前版本的真实密钥和证据时只能称为可选 Provider。

**自定义 OpenAI 兼容端点**（Ollama / 本地模型 / 私有网关）：

```yaml
provider:
  id: ollama
  baseUrl: http://localhost:11434/v1
  model: qwen2.5:7b
  apiKeyEnv: OLLAMA_API_KEY     # 无鉴权时可不配
  # contextWindow: 131072       # 可选：对齐真实模型能力（缺省 32768）
  # maxTokens: 8192             # 可选：最大输出（缺省 4096）
```

API key 来源可以是 `apiKeyEnv` 指定的环境变量，或后端无关的
`apiKeySecretRef: { secretRef: "opaque-id" }`。嵌入 Runtime 的宿主通过
`SecretResolver` 解析不透明引用；CLI、Python SDK 和标准 Worker 不注入 resolver，遇到
SecretRef 会以 `secret_reference_unresolved` 安全失败，且不会回退到明文或其他凭据来源。
显式 `apiKeyEnv` 缺失也使用同一错误码失败关闭。

自定义 Provider 的普通 Header 可继续使用字面量；Authorization、Proxy-Authorization、
X-API-Key、Cookie 等敏感 Header 必须使用 `{ env: "NAME" }` 或
`{ secretRef: "opaque-id" }`。引用和值不会进入日志、错误、Fact 或持久化数据。

> ⚠️ **不要用 `apiKey` 直填密钥**——会随配置文件进入版本库/分享链路。`coremind check` 和所有执行入口都会以 `execution_security_violation` 将它作为不可覆盖的安全错误。

## agents：智能体定义

```yaml
agents:
  reviewer:
    description: 给其他 agent 看的名片
    systemPrompt: 你是资深代码审查专家。        # 人设（缺省"乐于助人的助手"）
    model: deepseek-v4-flash                  # 可选：覆盖 provider.model
    tools:                                    # 可选：缺省继承全局 tools
      - id: read
      - id: grep
    options:                                  # 可选：模型选项
      temperature: 0.3                        # 0-2，低温度更稳定
      maxTokens: 2000
      thinkingLevel: low                      # off/low/medium/high/xhigh
    skills:                                   # 可选：注入专业技能（见技能指南）
      - code-review
```

### delegation：配置驱动的 Child Run

Delegation 默认关闭。只有父 Agent 在 `delegation.targets` 中显式列出的同项目命名 Agent，才会作为内建 `delegate` 工具的目标：

```yaml
agents:
  coordinator:
    systemPrompt: 负责拆解任务并汇总结果。
    delegation:
      budget:                 # 该父 Agent 的六维委派总池
        tokens: 4000
        toolCalls: 8
        costUsd: 1
        wallTimeMs: 120000
        steps: 12
        descendants: 4
      limits:                 # 可省略；默认分别为 3 / 4 / 32
        maxDepth: 3
        maxActiveChildren: 2
        maxDescendants: 4
      targets:
        researcher:
          preapproved: true # 仅 assisted 模式可据此自动批准合规委派
          budget:
            tokens: 2000
            toolCalls: 4
            costUsd: 0.5
            wallTimeMs: 60000
            steps: 6
            descendants: 0
  researcher:
    systemPrompt: 只完成收到的研究任务并返回证据。
```

父级 `delegation.budget` 和每个 Target 的 `budget` 都必须完整声明六个维度。父级预算池按父 Agent 隔离；Target 预算是该目标的固定默认值兼硬上限。模型调用 `delegate` 时只能提交 `target`、`task`、显式 `fact:` / `artifact:` 引用，以及可选的更小六维预算、`maxDepth` 或 `maxActiveChildren`；不能内联覆盖 Agent、Provider、model、tools、permissions、路径、网络、凭据或 workspace。工具只存在于活动父 Run 内，创建的 Child Run 继承项目 Provider 与 canonical Workspace，并以独立 RunId、Fact 和结构化结果参与同一 Projection。

层级默认上限是最大深度 3、每个父 Agent 最多 4 个活动 Child Run、总后代数 32；Config 与单次委派都只能收紧。可证明发生在首个委派 Fact 持久化前的初始化失败会释放本次预留；一旦 `child_created` 已持久化，未使用的 token、工具调用、费用、wall time、步骤或后代额度都不会退款。若关键创建 Fact 的提交结果未知，系统会保留已记录的身份和预算，等待 orphan audit，而不会复用 DelegationId。相同 DelegationId 与相同规范化输入只返回原 ChildRunId；同 ID 不同输入以 `delegation_conflict` 失败，且不会产生第二次执行。

成功且执行已静止、所有权已释放、没有 started/unknown Effect 的 Child Run 在 `parent_joined` 后默认接受；已完成的 committed Effect 不会把成功结果改成失败，但不能作为安全重新委派的证明。失败、主动取消、超时、预算耗尽，以及带有上述未决风险的异常成功结果会让父级进入持久处置门：父 Agent 必须调用 `dispose_delegation`，提交原 `delegationId`、`accept_failure` / `choose_alternative` / `redelegate` / `propagate_terminal` 之一和非空理由，才能继续或结束。恢复审计会在任何新 Provider 请求前把失去所有权的活动子级依次持久化为 `child_orphaned` 和 `parent_joined`，随后强制进入人工处置门；orphan、started/unknown Effect、未静止和执行所有权不明都不能由父 Agent 自行解封。Protocol v2 客户端可在父 Run 已暂停且 Runtime 不活动时提交 `delegation_disposition` 控制，该回执先是 `accepted`，恢复并重建 Child Coordinator 后才会成为 `applied` 或 `rejected`。

`redelegate` 只记录重新委派意图，不自动重跑。只有持久 RecoveryDisposition 明确为安全重放时，后续 `delegate` 才能用新的 DelegationId、新预算并填写 `recoveryOf: <原 DelegationId>` 建立关联尝试；复用原身份、缺少关联或 Effect 状态不安全都会失败关闭。父级自身已经取消、超时或失败时，系统先暂停等待 Child Disposition，并持久保留原父级终态；处置完成后恢复原终态，不重新请求 Provider。父终态形成前已记录但尚未创建 successor 的 `redelegate` 会持久撤销；父终态形成后新提交的 `redelegate` 会被持久拒绝，必须改用不会创建新 Child 的处置。

委派审批矩阵独立于普通低风险工具：`ask` 每次都要求批准；`assisted` 只有目标显式设置 `preapproved: true` 且请求满足全部硬边界时才自动批准；`full` 可免逐次批准创建合规 Child Run。显式 deny、allowlist、六维预算、父子工具不扩权、路径、网络和凭据边界在三种模式下都优先，不能被人工批准绕过。审批绑定固定目标、任务、引用和实际生效预算，并携带与 `delegation_recorded.inputFingerprint` 完全相同的 Child Run 输入指纹；任何变化都需要新批准。

Delegation Approval 只允许创建该 Child Run，不批准子级后续操作。Child Run 使用自己的 ToolPolicy；其文件、网络或外部 Effect 仍按继承权限独立自动判断或申请批准，并在子 Run 中记录独立审批事实。

启用 Delegation 时，父级 `runtime.maxTokens` 和 `runtime.maxCostUsd` 必须显式配置；`delegation.budget` 不能超过 Runtime 实际剩余预算，每个 Target 预算也不能超过其父 Agent 的委派池。省略 `delegation`（或没有任何 target）不会向模型暴露 `delegate`，也不会产生 Child Run Fact。

## tools：工具

**内置工具**（白名单）：`read` / `ls` / `find` / `grep` / `bash` / `edit` / `write` / `git_status` / `git_diff` / `git_log` / `web-fetch` / `web-search`（web-search 需要 `TAVILY_API_KEY`）。三个 Git 工具只读且参数固定，不能替代提交、切换、清理或推送命令。

```yaml
tools:
  - id: read
  - id: git_status
  - id: git_diff
  - id: bash
  - id: web-search          # 未配 key 时会跳过并告警
  - path: ./my-tool.ts      # 自定义脚本工具（JS/TS，default 导出工具对象）
    effect:                 # 必填：让权限层在执行前判断真实副作用
      operations: [write]  # read / write / process / network / external
      reversible: true
```

如果自定义工具的路径或 URL 参数使用了非标准字段名，可再声明 `pathFields` 或 `urlFields`，支持 `output.path` 这样的点号路径。缺少 `effect` 的自定义工具不会通过配置校验，也不能使用 `read`、`write`、`bash` 等内置工具名。

注意：单个 agent 工具超过 20 个会告警（工具过多会降低模型选择准确率）。

> 配置里的相对路径（自定义工具 `./my-tool.mjs`、`skills/` 目录、`session.dir`）都相对**配置文件所在目录**解析；`.env` 则跟随运行命令的目录。详见 [CLI 使用指南](05-cli-usage.md#3-在哪里运行目录规则新手最容易困惑的部分)。

## workflow：编排步骤

五种步骤，可嵌套（parallel/if/switch 内部可再含步骤）：

```yaml
workflow:
  - id: collect
    type: prompt            # 派发任务（call 语义相同，用于委托）
    agent: collector
    input: 请收集信息：{{prompt}}    # {{变量}} 插值
    saveAs: changes         # 输出保存为 {{changes.text}}
    retry:                  # 可选：质量把关——输出不达标自动重试
      max: 2                # 最大重试次数（默认 1）
      if: "{{text}} contains 错误"   # 为真 = 需要重试；{{text}} 是本步输出
  - id: branch
    type: if
    condition: "{{changes.text}} contains 无"
    then: [...]
    else: [...]
  - id: checks
    type: parallel          # 并行执行，结果按声明顺序聚合
    steps: [...]
    saveAs: checks
  - id: classify
    type: switch            # 多路选择（变量值包含 case 键即命中）
    on: checks.text
    cases:
      高风险: [...]
    default: [...]
```

**变量**：`{{prompt}}` = 首条用户输入；`{{<saveAs>.text}}` = 步骤输出。

**护栏**（保证智能体不失控）：嵌套深度 ≤ 8、总步骤 ≤ 100、单步骤超时 5 分钟（超时自动中止）。可用 `--max-steps <n>` 收紧步骤上限。

## loop：显式验证与有界修复

当业务要求“候选结果必须由独立步骤验证，失败后才能有限修复”时使用 `loop`。固定步骤仍应使用 `workflow`；两者不能同时配置。

```yaml
loop:
  planning:                         # 可选：先规划，再执行
    agent: planner
    input: "规划：{{prompt}}"
  execute:
    agent: coder
    input: "执行：{{prompt}}"
  verify:
    agent: reviewer
    input: "验证：{{candidate.text}}"
    passIf: "{{text}} == PASS"      # 必填：确定、可测试的通过条件
  repair:
    agent: coder
    input: "根据 {{verification.text}} 修复 {{candidate.text}}"
  maxIterations: 3                 # 默认 3
  maxRepairs: 2                    # 默认 2
  maxRepeatedAction: 2             # 相同候选达到阈值即判定无进展
  onFailure: repair                # repair / pause / fail
  onExhausted: fail                # pause / fail
```

可用变量包括 `{{prompt}}`、`{{plan.text}}`、`{{candidate.text}}`、`{{verification.text}}`、`{{iteration}}` 和 `{{repairs}}`。verify 未通过时不会返回成功；达到迭代、修复、无进展、预算或超时上限时会进入明确的暂停或失败终态。

Loop 在每个稳定状态保存版本化快照。使用 `coremind run coremind.yaml --resume <runId>` 可从暂停或意外中断的稳定边界继续。工具副作用同时记录 `started`、`committed` 或 `unknown` 收据：已提交副作用不自动重放，未知副作用要求人工核对。

完整的失败注入、暂停恢复和耗尽处理见[验证修复黄金示例](../../examples/golden/verified-repair-loop/README.zh-CN.md)。

## runtime：多维预算

```yaml
runtime:
  maxTurns: 20
  maxSteps: 100
  stepTimeoutMs: 300000
  runTimeoutMs: 900000
  maxToolCalls: 50
  maxToolFailures: 3
  maxRetries: 3
  maxTokens: 100000       # Provider 有 usage 时生效
  maxCostUsd: 2           # Provider 有费用数据时生效
```

超限会产生结构化 `budget_exceeded` 事件并明确结束，不能伪装成成功。

## permissions：三档权限

```yaml
permissions:
  mode: ask               # ask / assisted / full
  workspaceOnly: true
  network: ask            # ask / allow / deny
  allow:
    - lookup_order
  deny:
    - bash
```

显式 `deny` 和工作区路径保护始终优先，包括 full 模式。full 只代表不逐项询问，不关闭 Trace、审计、checkpoint、Effect Receipt 或恢复检查。Windows 宿主 Shell 只有在 full、`workspaceOnly: false`、`network: allow` 同时明确选择时开放；其他组合安全拒绝。Git Bash 只提供命令兼容性，不提供隔离；自定义工具的未知副作用在受约束模式下也会安全拒绝。

## telemetry：本地观测与进程外投影

本地观测始终开启，不需要配置。下面的字段只控制可选的进程外 Telemetry Projection；省略整个区块等价于 `DISABLED`。

```yaml
telemetry:
  mode: DISABLED              # DISABLED / FEEDBACK_ONLY / FULL
  # endpoint: https://otel.example/v1/traces
  contentLevel: metrics_only  # metrics_only / content
  allowedFields: []
```

- `DISABLED` 不构造 Exporter、不读取外传凭据，也不会因为环境变量或安装了监控包而自动启用。
- `FEEDBACK_ONLY` 只有在 Runtime 先 critical 持久化带范围指纹的 feedback consent 后，才允许发送该 consent 覆盖的事实前缀。
- `FULL` 只投影持久配置生效后的允许字段。默认 `metrics_only` 禁止提示、回复、工具参数/结果、命令、文件正文、完整路径和凭据。
- `content` 还需要独立的 content consent，并绑定同一 `runId`、目标 origin、字段范围、保留目的和撤销方式；只在 YAML 写 `content` 或 `allowedFields` 不构成授权。
- 本地状态只显示 endpoint 的 origin，不显示 query、userinfo 或凭据。`handed_off` 表示交给 Exporter，不表示接收端已经保存。

当前源码提供可注入 Exporter seam 与离线故障测试，不自带 OTel Adapter，也未授权真实 OTLP endpoint、凭据或网络测试。启用模式必须同时配置 `endpoint`；没有 Adapter 时运行结果不受影响，但本地交付投影会显示 `exporter_unavailable`。受信任 Adapter 必须在有界超时内执行精确 origin、DNS 解析、禁止 redirect/proxy 和严格 TLS 策略，再把解析地址与策略收据交给 Core；Core 只校验收据结构和指纹，不能证明网络策略确实执行。`createTelemetryEgressAuthorization` 只是收据构造器，不是 DNS/TLS 认证。

恢复运行时可以更改 Telemetry 配置而不改变运行身份；Runtime 会先 critical 持久化新的 `telemetry_configuration` Fact，`FULL` 只从该 Fact 的生效 sequence 向后投影，不回填此前事实。

## quality：质量档

```yaml
quality:
  profile: standard       # development / standard / strict
  minScenarioPassRate: 1
  allowOverride: true
```

strict 会让每个评测场景至少运行 3 次。安全门禁不可覆盖；其他门禁只有在明确填写覆盖原因后才会留痕放行。详见[质量、Harness 与评测](04-quality.md)。

## session：会话持久化

```yaml
session:
  enabled: true             # 开启会话落盘
  dir: ./sessions           # 可选：存储目录（缺省为配置目录下 sessions）
  compact: true             # 可选：上下文超预算时自动压缩（LLM 摘要，消耗 token）
```

配合 `--session <id>`：保存本轮对话；再次运行同一 id 时**自动恢复历史**（重启后上下文不丢）。

```bash
coremind run coremind.yaml --prompt "第一轮" --session my-session
coremind run coremind.yaml --prompt "第二轮" --session my-session   # 已恢复会话 my-session（2 条历史消息）
```

> 会话 id 只能包含**字母、数字、连字符与下划线**（`[a-zA-Z0-9_-]`）——其他字符会报错（防路径穿越）。

## 完整示例

最简配置（单 agent 直答）：

```yaml
schemaVersion: 2
name: hello
provider:
  id: deepseek
agents:
  assistant:
    systemPrompt: 你是一位友善的 AI 助手。
runtime: {}
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
quality:
  profile: standard
```
