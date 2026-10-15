# 配置指南

`coremind.yaml`（也支持 JSON）是智能体的唯一定义文件。本指南按字段逐个说明。

## 顶层字段

```yaml
schemaVersion: 2        # 保留旧配置；使用 deferred 工具时须显式改为 3
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

**内置提供商**：`1.0.1` 共提供 40 个可配置入口，包括 39 个继承入口和 1 个 CoreMind 原生入口；可通过 TypeScript SDK 的 `listInheritedProviders()` 查看当前安装版本的继承清单。可配置不等于真实认证。[静态供应商矩阵](../providers/README.zh-CN.md)尚未收录 `1.0.1` 认证记录；正式发布必须使用绑定最终提交和 Runtime 摘要的严格认证证据，可在同版本 [Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v1.0.1) 对应的 Candidate 工作流中核对。部署到其他模型、凭据或环境仍需单独复验。

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
X-API-Key、API-Key、X-Auth-Token、X-Access-Token、X-Goog-API-Key、
X-Amz-Security-Token、Cookie 等敏感 Header 必须使用 `{ env: "NAME" }` 或
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

### 按需曝光工具（1.1 开发线）

工具的 `exposure` 可省略或设为 `direct`；省略时仍按原方式把完整参数 schema 交给模型，旧 Config 2 的解析、配置指纹与声明行为保持不变。使用 `deferred` 必须显式选择 `schemaVersion: 3`；Config 2 带 `deferred` 会静态拒绝，不会自动升级。最小片段如下，完整示例见 [tool-discovery.yaml](../../examples/tool-discovery.yaml)：

```yaml
schemaVersion: 3
name: deferred-reader
agents:
  main:
    tools:
      - id: read
        exposure: deferred
```

仅当本次执行包含 deferred 工具时，模型才会得到 `discover_tools({query, limit?})`。目录只来自当前 Agent 配置允许的工具，不搜索其他 Agent 或未配置的服务工具。搜索按名称和描述做 Unicode NFKC 规范化、中文二元词与英文词法匹配，不提供翻译或语义检索。`query` 最长 256 个 Unicode 码点，`limit` 为 1–8，默认 5；单次结果上限 16 KiB。启用此模式的合并目录最多 256 项，完整 schema 总量不超过 8 MiB。

搜索本身不出网、不读取脚本或启动进程；这不免除原有准备工作：已选择的 MCP 工具仍先按原权限连接、握手及读取目录，可能产生 I/O。命中先写入关键事实，完整工具 schema 只有在下一模型请求边界完成持久安装后才曝光；同一批工具调用里先搜索再猜名，仍不能提前执行。命中和安装都不替代执行时的 deny、审批、路径、网络、预算或副作用检查。

每个新 Run 从当前配置重新建立声明，不继承旧 Run、Session 或父级的激活集合。同一 Run 恢复仍受原配置指纹硬门约束，不能通过旧搜索结果放宽权限。Skill、委派、资源派生和宿主注入工具继续直接曝光。公开 `context_prefix` 与 `provider_request` 只增加可选的版本、目录指纹、代次、选择指纹和工具数量摘要；完整目录与参数 schema 留在私有 Run Facts，不出现在公开投影或 Worker 事件中。

声明按每次 execution 隔离：同一 Run、Agent 和 Step 的质量重试也重新建立 deferred 声明。只有最后的权威暂停记录精确绑定待续的 execution 时，恢复才沿用该执行已持久化的选择代次；成功完成的执行不会列为待续。崩溃没有该绑定时，不借最近同 Agent/Step 的旧激活；若原恢复门允许继续，则建立新的 deferred 声明。此规则只决定工具声明，不代替会话消息或请求重建，也不放宽恢复准入。

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
    passIf: "{{text}} == PASS"      # Agent 验证模式必填
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

### 宿主验收模式（0.8.0）

业务应用需要自己验收候选时，可在原 Loop 中改用宿主验证。下面是 `loop` 配置片段，仍需在 `agents` 中定义 `coder`；`execute`、`repair` 和迭代上限仍由 Loop 管理：

```yaml
loop:
  execute: { agent: coder, input: "{{prompt}}" }
  verify: { mode: host, timeoutMs: 30000 }
  repair: { agent: coder, input: "按宿主反馈修正：{{verification.text}}" }
  maxIterations: 3
  maxRepairs: 2
  onFailure: repair
  onExhausted: pause
```

宿主模式不设置 `verify.agent` 或 `passIf`。TypeScript 的 `onVerification` 只通知候选；宿主必须独立核对 Run、请求身份、候选摘要及业务对象，并用 `acceptControl` 提交接受或拒绝。Python 宿主显式启用 Protocol v2 后，用 `submit_verification` 回复。`accepted` 仅表示收件，`applied` 也不等于运行成功；最终读取 Projection outcome。拒绝后在**同一 Run** 内有界修复，未知结果和暂停状态不能作为验收通过。可运行的离线示例及恢复规则见[宿主验收示例](../../examples/host-verification/README.md)。

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

`provider.contextWindow` 是上下文容量，`provider.maxTokens` 是单次模型输出上限，`runtime.maxTokens` 是累计 Run 预算；启用 Child Run 时还要分别声明父级和目标的六维委派预算，不能互换这些数值。

## mcp：按 Agent 选择本地工具

本地 stdio 服务仅在真实 Run 内、获准后启动。`command` 和 `cwd` 必须为绝对路径，`args` 是固定参数数组，不经过 Shell，也不会自动安装程序。将下面的路径和原始工具名替换为已经审核的本地服务：

```yaml
mcp:
  servers:
    local:
      transport: stdio
      command: /absolute/path/to/node
      args: [/absolute/path/to/server.mjs]
      cwd: /absolute/path/to/workspace
      env:
        SERVICE_TOKEN:
          env: LOCAL_SERVICE_TOKEN
agents:
  assistant:
    tools:
      - mcp:
          server: local
          tool: echo
        effect:
          operations: [external]
          reversible: false
        capability:
          effect: external
          replay: unknown
          concurrency: run_serial
          checkpoint: unsupported
          durability: critical
permissions:
  mode: ask
  workspaceOnly: false
  network: allow
```

Windows 使用绝对 Windows 路径；YAML 中可用单引号保留反斜杠。环境字段只能引用 `{env: 名称}` 或 `{secretRef: 引用}`，后者需要 SDK 的 `secretResolver`。CoreMind 只传递有限的平台运行变量和显式引用，不透传整个宿主环境。不要在配置、参数或工具描述中填写秘密。

Agent 的非空 `tools` 精确选择工具；省略或空列表沿用全局 `tools`。内部短名绑定服务、原名、完整 schema 和执行能力，审批展示真实命令、目录与身份摘要。连接、读取目录、每次业务调用分别通过同一审批、预算、租约及持久化链，因此连接加目录读取先消耗两次工具预算。默认 direct 工具的原始 schema（含 `$defs/$ref`）进入首次模型请求；deferred 工具在发现并持久安装后的请求中保留同样完整的 schema。服务的 annotations 不会自动降低权限。

这是受信任宿主程序，具有当前账户权限；`roots` 或工具白名单不构成操作系统沙箱。`workspaceOnly: true` 或 `network: deny/ask` 会在启动前拒绝，`full` 也不豁免。`doctor` 只检查静态条件，不启动或握手服务；既有 `coremind check` 仍拒绝 `workspaceOnly: false`，本配置不满足受限项目的发布基线。当前 Child Run 不接受 MCP 服务、工具或凭据。

默认 `protocolVersion: legacy` 不进行额外进程探测；只有确认服务支持时，才显式设置 `2026-07-28`。文本与 JSON 结果保持语义，较大结果存为本地 Artifact；远端提供的文件路径不会触发宿主读取。连接属于本次 Run 的执行，结束或取消时关闭；已启动的 process/external 效果可能无法撤销，现有冷恢复门会要求人工审计，不自动重放。该配置需要支持 MCP 引用的 Worker，旧 Worker 会拒绝选中的新工具配置；没有选中 MCP 的旧配置保留原行为。

## MCP：受控 HTTP 与精确资源授权

HTTP 服务使用固定的 `streamable-http` 目标。下面是仅选择资源的配置片段；将服务 URL 和资源 URI 替换为已审核服务实际提供的值：

```yaml
mcp:
  servers:
    remote:
      transport: streamable-http
      url: https://mcp.example.com/mcp
      headers:
        Authorization:
          env: MCP_AUTHORIZATION
agents:
  assistant:
    mcpResources:
      remote: ['fixture://first']
permissions:
  mode: ask
  workspaceOnly: true
  network: allow
```

`MCP_AUTHORIZATION` 的值必须是完整 Header 值，例如 `Bearer <服务令牌>`；CoreMind 不自动添加 `Bearer`。凭据也可使用 `{secretRef: 引用}`，由 SDK 的 `secretResolver` 解析。敏感 Header 不接受明文配置，引用缺失、空值或解析失败会明确拒绝；不会退回匿名身份或其他 Provider 的密钥。URL 不允许 userinfo、query 或 fragment。Header 凭据只用于该固定目标，不进入模型上下文、Facts 或 Worker JSON；Header 模式的 401/403 明确失败，不触发登录、刷新或业务重试。需要交互认证的服务使用下方独立的 OAuth 配置。

公网 HTTPS 默认只允许核验后的公网地址。`allowedAddresses` 是该目标的精确 IP 字面量集合；配置后，解析出的全部地址都必须命中，私网地址也必须显式列入，不支持 CIDR 或主机名。明文 HTTP 只允许 URL 本身为 loopback IP 字面量且地址同时显式允许，例如：

```yaml
transport: streamable-http
url: http://127.0.0.1:8765/mcp
allowedAddresses: ['127.0.0.1']
```

`http://localhost` 不满足这一边界；unspecified、multicast、link-local 等非法目标也不能通过允许表放开。每次获准连接均核验 DNS 答案，并固定实际 socket 使用的地址；HTTPS 保留原主机名的 TLS/SNI 校验。所有重定向均拒绝，不读取宿主代理环境变量。`doctor` 仍只做静态检查，不解析 DNS、联网或握手。

工具选择继续使用前一节的 `tools[].mcp` 原始服务名/工具名与完整 Effect/Capability 声明，和资源选择相互独立。HTTP 连接、工具目录和资源操作按 `network` 准入；`network: allow` 是配置批准，即使 `mode: ask` 也不会重复询问，`network: ask` 仍走原网络审批，显式 deny 始终优先。业务工具的实际 `external` 等声明和工作区硬门保持不变；HTTP 传输不会把副作用工具降级为只读网络调用。

`agent.mcpResources` 只认完整 URI 原字符串，不解码、规范化或按前缀扩权。省略、`{}` 或 `remote: []` 都不授权，也不从全局、父级或其他 Agent 继承。资源目前仅支持 HTTP，stdio 资源明确不支持。非空集合才暴露 list、templates、read 三个资源工具：列表只返回允许 URI，模板仅作过滤展示，读取仍须精确命中集合，响应中的附带 URI 同样受检验。URI 只发往固定 MCP 目标；`file:`、链接或 HTML 不会引发宿主文件读取、额外网络请求或执行，二进制 blob 明确拒绝。

只选择工具时不会隐式列出资源；仅选择资源且没有继承 MCP 工具时，首个模型请求前 HTTP 次数为零，明确调用资源工具后才连接。连接和操作继续经过同一 Run Harness、预算、关键持久化与收据链。Child Run 不继承 MCP 服务、工具、资源授权或凭据；新 HTTP/资源配置需要相应 Worker 能力，旧 Worker 必须明确拒绝。

每个响应 body 最多 8 MiB，同 owner 累计最多 64 MiB；目录最多 32 页、256 条，单次请求及目录操作总期限为 30 秒。每个 owner 的 GET 恢复最多 3 次、总窗口 30 秒，不重发业务 POST。单请求取消不关闭其他合法请求；Run 关闭等待本地 body、socket 和 dispatcher 收敛。不会发送远端 DELETE，服务端 session 的最终清理由服务租约负责。文本/JSON 和较大 Artifact 沿用既有结果边界，未知远端写效果不自动重放。

## MCP：宿主显式交互认证（1.1 开发线）

HTTP 服务可使用预注册 public/native client 的 Authorization Code + S256。以下配置替换同一服务的 `headers.Authorization`，两种凭据来源不能同时配置：

```yaml
mcp:
  servers:
    remote:
      transport: streamable-http
      url: https://mcp.example.com/mcp
      oauth:
        issuer: https://identity.example.com
        clientId: registered-native-client
        scopes: ['mcp:read']
```

`scopes` 是显式有限集合，可以为空；返回额外 scope 会被拒绝。`issuer` 是唯一受信授权方，资源元数据必须绑定固定 MCP URL 与该 issuer；授权、Token 端点必须与 issuer 同 origin，不接受跨目标端点或重定向。MCP 与授权方分别核验网络地址；授权方如需私网精确 IP 许可，使用 `oauth.allowedAddresses`，不会继承 MCP 的地址许可。明文 HTTP 同样仅支持显式允许的 loopback IP。当前不支持动态客户端注册、client secret、客户端凭据模式或跨 origin 授权端点。

宿主调用 `createMcpAuthentication({config})` 创建认证会话，创建本身不联网。显式 `login(server, {onAuthorization, signal})` 才开始发现并提供授权 URL，用户自行打开；CoreMind 不自动启动浏览器。缺少 handler 时立即返回 `mcp_auth_required`，不创建监听或发现请求。`network: deny` 始终阻止认证；`ask` 下显式 login 仅同意本次固定服务认证事务，不批准后续业务调用。登录整体期限为 180 秒，自发现前开始；Node 只在 `127.0.0.1` 随机端口接收一次有 state、issuer 与 PKCE 校验的回调。

默认凭据只存在当前宿主内存，重启需要重新登录。同一会话可注入多次 Runtime，Run 结束只关闭自己的连接。`logout(server)` 先撤销本地使用权并删除宿主存储记录；`close()` 取消事务和刷新、清理监听与内存，但保留显式持久化记录。两者不调用远端撤销接口。只有 Node 宿主可以注入 `McpTokenStore` 和稳定隔离的 `namespace`；存储实现负责安全、原子保存和有界取消，不默认产生明文文件，不把 SecretResolver 当作可写存储。存储失败明确返回 `mcp_auth_store_failed`，不回退旧凭据。

刷新按完整服务身份单飞，每位调用方独立取消；所有等待者取消后停止该刷新。每次真实出站前重新检查授权与调用取消，401 不会触发业务 POST 重发。Token、刷新状态和 callback code 不进入模型、Facts、日志、Artifact 或 Worker 消息；标准授权 URL 仅供临时宿主交互，不应持久记录。

TypeScript 用法见 [SDK 指南](../modules/embed-coremind-typescript/GUIDE.zh-CN.md)。CLI 使用同进程的 `coremind run coremind.yaml --mcp-login remote --prompt '读取资源'`，仅支持 TTY 人类输出，拒绝与 `--print`、`--json-events` 同用；chat 使用 `/mcp login remote`、`/mcp cancel`、`/mcp logout remote`。Python 交互须显式选择 Protocol v2 并提供 `mcp_auth_handler`，详见 [Python 指南](../modules/embed-coremind-python/GUIDE.zh-CN.md)。默认 v1 保持无交互，旧 Worker 或未协商能力明确拒绝，不降级伪报成功。

目前完整认证链由本地真实 HTTP 授权服务器夹具验证；真实外部服务互通尚未验证，不能据此宣称外部服务认证。Node callback 必须能从用户浏览器访问，远程容器的浏览器回调部署不在当前验证范围。

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

CoreMind 提供可注入 Exporter seam 与离线故障测试，不自带 OTel Adapter，也未授权真实 OTLP endpoint、凭据或网络测试。启用模式必须同时配置 `endpoint`；没有 Adapter 时运行结果不受影响，但本地交付投影会显示 `exporter_unavailable`。受信任 Adapter 必须在有界超时内执行精确 origin、DNS 解析、禁止 redirect/proxy 和严格 TLS 策略，再把解析地址与策略收据交给 Core；Core 只校验收据结构和指纹，不能证明网络策略确实执行。`createTelemetryEgressAuthorization` 只是收据构造器，不是 DNS/TLS 认证。

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
  compact: false            # 可选：默认关闭；设为 true 会额外请求模型生成摘要
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
