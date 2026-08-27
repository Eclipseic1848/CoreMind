# CoreMind 变更日志

本文件记录面向用户的重要变化。版本遵循语义化版本；预发布版本允许在发布说明中明确标注的接口调整。

[English](CHANGELOG.en.md)

## 0.7.0-dev — 2026-08-27（未发布源码候选）

- 新增由 Protocol 包拥有的类型化 Error Contract 注册表，覆盖现有稳定自有错误码并统一终态、取消、重试和人工处置分类。Runtime、Provider、Tool、Child Run 与 Evaluation 已迁移到该合同；自定义工具通过 `ToolExecutionError` 显式声明可预期的 `tool_execution_failed`，裸 Adapter 异常与其他未知外部码仅以脱敏审计信息进入 Outcome 与持久 Fact，公开码收敛为暂停且禁止自动重试的 `unclassified_error`。Protocol、CLI、TUI 与双 SDK 产品入口迁移仍待后续 P0 任务。
- Subagent 统一建模为完整 Child Run，新增稳定父子身份、幂等委派、单调 authority、父预算划拨、结构化取消/join、orphan audit 与递归树投影。
- 真实 Child Runtime Adapter 在执行前验证同一 authority、RunId、AbortSignal、任务、实际模型、canonical Workspace、权限、工具、环境探针和有限预算。
- Protocol v2、Worker、TypeScript `RunResult`、CLI JSONL、TUI `/children` 与 Python bundled worker 共享同一 Fact Projection；1,000 个确定性交错种子覆盖兄弟并发、重复委派、取消、失败与 join。
- Windows 本地跨进程验收覆盖父进程崩溃后的 orphan audit、Child Worker 崩溃、父取消后无遗留子进程、Effect 不重放，以及父子 Workspace 竞争只有一个 Writer；当前不支持 durable detach，真实多 Agent 产品验收、远端 CI、合并和发布尚未完成。
- Phase Gate 已同步双语 README 与安全策略；行为准则、贡献指南和 MIT License 的事实、流程与联系人未变化，因此保持不变。GitHub About 需在远端交付授权后同步，当前未改动。

## 0.3.2 — 2026-08-26（已合并候选，尚未发布）

### Replay 与显性可观测性

- 新增 deterministic `ReplayKit`，从固定 Run Facts 与 Provider request fixture 重建 RunSnapshot、Context、Artifact、RecoveryDecision 和本地观测；0.3.0/0.3.1 缺少 Telemetry 字段的历史 Fact 显式标记为 `legacy_default`。
- `RunResult.observability`、CLI JSONL、TUI `/observability`、Worker 与 Python SDK 共享同一 Fact Projection，显示 Run/Turn/Call、耗时、错误、Context、Artifact、共享状态、Telemetry 模式、脱敏 origin、授权范围和交付队列。
- Telemetry 默认 `DISABLED`，不构造 Exporter、不读取凭据。`FEEDBACK_ONLY` 只接受绑定同一 Run 与 canonical Fact 前缀指纹的持久 consent；`content` 需要声明保留目的和撤销方式的独立授权。模式、目标、字段或范围指纹不一致均失败关闭。
- Exporter DNS/TLS/401/429/timeout、queue full、重复、drop、脱敏失败和 shutdown 超时只更新可丢弃的交付投影，不改变 RunOutcome、Facts 或恢复结论；`handed_off` 明确不等于接收端 delivered。
- 当前源码只交付可注入 Exporter seam、受信任 Adapter 收据合同与离线故障证据；Core 校验精确 origin、解析地址、redirect/proxy deny、TLS strict 和收据指纹，但该收据不证明网络策略真实执行。没有新增 OTel 依赖，也没有执行真实 OTLP endpoint、凭据或 Telemetry 出网；`0.3.2` Provider 七项认证是独立证据，不能替代 Telemetry 出站验证。

### Context 生命周期与长任务

- 按实际 Provider/model 和本次请求解析 Context 窗口、输出上限与证据来源；多个可信候选取安全交集，未知、冲突、路由不匹配、请求输出超限和多模态占用未知均在 Provider 前失败关闭。
- 完整预算本次输出、稳定前缀、工具 Schema、结构化输出、协议开销与安全余量；压缩用 Runtime Facts 投影的 TaskState 替换旧前缀，并保留上一完整 Turn 与当前未完成 user 消息。
- 每次压缩把摘要写入 Session，并持久化可验证的父链 Ledger；达到深度阈值后从 canonical Session 消息重建。无可持久化 Session、Artifact 漂移或 lineage 损坏时返回结构化暂停，不静默截断。
- Runtime、Protocol、CLI 与双 SDK 共享预算、压缩和失败投影；Provider 报告超窗时不盲目重试相同请求。真实 Provider 认证是独立证据门禁，`0.3.2` 候选已完成七项复验。

### 工具能力与恢复

- 为每个 Tool Call 解析并持久化唯一、不可变的 `ResolvedToolCapability`，统一 Policy、Approval、Checkpoint 与四入口投影的安全判断。
- 未注册、残缺、冲突及跨维度不安全声明统一失败关闭；External Observable Read 不再仅凭名称或 `replay: safe` 宣称可安全重放。
- 旧 `effect` 声明保持兼容并保守迁移；0.3.0/0.3.1 历史记录缺少 Capability Fact 时显式投影为 `legacy/unknown`。
- 新增唯一 Tool Call 生命周期 reducer 与正交结果轴；成功、拒绝、工具错误、持久化错误、取消和超时均形成可离线重建的单一终态。
- Runtime、RunSnapshot、Worker 与双 SDK 的恢复判断统一复用持久化 lifecycle 投影；non-idempotent 或 unknown Effect 一旦可能开始，不会自动重放。
- `RunStore` 新增 ordinary/critical 能力与 acknowledgement 合同；File Store 只承诺经 Windows/Linux 进程崩溃探针验证的边界，Memory Store 不再把内存可见伪装为 critical。
- Checkpoint、started Receipt 与关键 Tool Result 在 Adapter 前后使用 critical barrier；失败保持执行、Effect 与持久化轴正交，并提供分级指标。

### Provider 兼容

- 自定义 OpenAI-compatible Provider 可显式声明 `thinkingFormat: qwen`；当 Agent 使用 `thinkingLevel: off` 时，Runtime 会通过公开配置合同发送 `enable_thinking: false`，不开放任意请求体透传。
- 自定义 Provider 现在拒绝 Schema 之外的字段，避免把凭据或未受审计参数作为任意请求体注入。

### 发布工程与候选状态

- 8 个 npm 包、精确内部依赖、Python 包、21 个模块合同、真实终端证据模板和内嵌 Python worker 已同步到 `0.3.2`。
- Release Please 的草稿转换步骤显式绑定当前 GitHub 仓库，使无 checkout 的工作流也能定位新建 PR；仍不会自动合并、打 Tag 或发布。
- 阶段 Gate 复核已同步 README 与安全策略；行为准则、贡献指南和 MIT License 没有事实、流程或联系信息变化，因此保持不变。GitHub About 作为仓库设置在同一 Gate 中单独同步。
- 本条目描述已合入 `main` 的未发布候选。`0.3.2` 的 Node 22 双平台 CI、真实 Provider 七项认证与 RC 验收已完成；Tag、Registry、GitHub Release 与发布后公共文档同步尚未执行，当前公开稳定版仍为 `0.3.1`。

## 0.3.1 — 2026-08-21

### 运行事实与身份

- 新增 Run、Turn、Step、Call、Receipt、Approval、Checkpoint 与 Operation 的类型化身份，同时保持现有面向字符串的公共 API。
- 使 Session、Run 与压缩记录可从当前及 `0.3.0` 历史数据重建，并提供确定性的 Provider 请求回放 fixture。
- 新增可独立执行的 I-1～I-12 关联检查，支持 `off`、`eval` 与发布 `gate` 三档；版本化 fixture 覆盖当前和历史事实。

### 取消与恢复

- 将中止准入前置到 Trace 与 journal 落盘之前，在 guard 处收敛迟到事件，中断后只保留已确认的 transcript/session 事实。
- 新增可持久化输入收据、claimed/completed/discarded 转移、静止判定与恢复连续性，且不落盘输入正文。
- 新增 1,000 固定种子取消竞态矩阵、Provider 迟到回复隔离、四入口取消覆盖及可回放失败诊断。

### 发布工程

- 普通功能 PR 显式延后 Provider 认证；Release Please 候选、`main` 与手动运行继续执行严格认证。
- 修复 manifest 模式忽略手动 `release-as` 的问题：候选工作流改用可锁定输入版本的非 manifest 入口，且新建 PR 后立即幂等转为草稿。
- 将 8 个 npm 包、内部精确依赖、Python 元数据、模块合同与真实终端证据模板统一到 `0.3.1`。
- 修复模块变更记录生成器使用历史常量 `2026-08-12` 的问题，改为写入候选日期。

### 发布状态

- `alibaba-model-studio/qwen-plus` 已在 `0.3.1` Runtime 上完成七项真实认证；双平台 CI、P01～P20、真实伪终端、严格预检与 RC 自动验收矩阵全部通过，最终发布提交为 `bdc8eb8ef66c586212311ab6e071e502c9dd8cb2`。
- `v0.3.1` Tag、[GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.1)、8 个 npm 包及 `latest`、[PyPI](https://pypi.org/project/coremind-ai/0.3.1/)、来源证明、独立源码 ZIP 和双语文档站已发布；公共 Registry 全新安装与 Release 资产哈希复核通过。

## 0.3.0 — 2026-08-14

### 稳定化结论

- 基于公开 `0.3.0-rc.2` 完成 npm CLI、TypeScript SDK、PyPI Python SDK、独立源码 ZIP 的 Windows/Linux 干净环境 Dogfooding，以及维护者 Windows TUI M01～M09 人工验收；未发现稳定版硬阻断。
- 不创建只为占版本号的 `0.3.0-rc.3`；该候选仅同步稳定版版本、发布元数据和必要文档，不新增用户可见功能，不改变 Config、Protocol、终态、权限、副作用或恢复语义。
- 八个 npm 包、内部精确依赖、Python 包、模块合同、真实终端证据模板和 Release Please 清单统一为 `0.3.0`；历史 rc.2 发布物、验收记录和 Provider 证据保持不可变。
- 修复稳定版版本同步时把 `0.3.0-rc.2` 模块记录误认成 `0.3.0` 的标题匹配问题，并增加目标回归测试。
- `alibaba-model-studio/qwen-plus` 已在 `0.3.0` 发布 Runtime 上完成流式、工具调用、结构化结果、多轮、中止、错误映射和长上下文七项真实复验；证据只记录合成数据摘要、版本、发布源码提交和 Runtime SHA-256。

### 发布状态

- 完整双平台自动门禁、精确 `main`、最终 Windows 人工验收和 Release Readiness 已完成；最终发布提交为 `dc6e45489b06f3c28da1934f063fbfbc671c05ef`。
- `v0.3.0` Tag、[GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.0)、8 个 npm 包及 `latest`、[PyPI](https://pypi.org/project/coremind-ai/0.3.0/)、独立源码 ZIP 和[双语文档站](https://eclipseic1848.github.io/CoreMind/)已发布；公开产物重新下载后的哈希与同一次发布构建一致。

## 0.3.0-rc.2 — 2026-08-12

### 可靠性与安全

- 生命周期扩展统一使用递归脱敏，未声明凭据能力的扩展不再收到 Cookie、私钥、带敏感参数的 URL 或命令值。
- RunState 与 operation 日志按落盘顺序验证；只修复尾部 JSON 语法截断，语义损坏或乱序记录会失败关闭。
- 审批通过后才记录工具副作用已开始；审批拒绝产生 `not_started` 收据，暂停运行可从稳定边界继续。
- 每次运行的工具副作用、幂等键和计时状态已抽离为独立协调器，降低 Runtime 编排变更的耦合风险。

### Harness、Loop 与 SDK

- Coding/Engineering Kernel 的通过结果绑定 Runtime 实际工具执行、命令退出码、测试分类、checkpoint 和 diff 证据；调用方手填的“通过”不再满足交付门禁。
- Config 的工程证据策略、Protocol 嵌套 Schema 和公开类型合同已收紧；公开 TypeScript 声明不再泄漏低层运行依赖类型。
- Provider 环境变量只从显式注入环境解析，嵌入式测试和宿主进程不会静默串用凭据。
- Python wheel 内置 Worker 新增版本、协议和 SHA-256 Manifest，SDK 启动前会拒绝版本或内容漂移。

### CLI、模板与发布

- `coremind create` 会显式选择 Provider、模型和凭据环境变量；非交互模式未指定 Provider 时失败并给出修复命令，`coremind providers` 区分“可配置”和“已认证”。
- 默认模板统一使用当前已认证 Provider；博客、合同和周报模板减少重复审批，且明确禁止发明未提供的业务事实。
- Windows/Linux CI 新增真实伪终端 P20：启动、帮助、状态、流式输出、审批拒绝/批准、会话恢复、checkpoint diff/restore、中止和退出均绑定同一提交。
- 发布工作流只接受 `main` 最新提交、同提交双平台 CI 和 P20 证据；npm、PyPI 与 GitHub Release 的断点续传仅在既有资产哈希一致时跳过，冲突会失败关闭。
- 版本同步覆盖根清单、8 个 npm 包、Python SDK、21 个模块、P20 模板和生成器；公开文档不再硬编码会漂移的 Markdown 文件数量。

### 已知边界

- 真实外部同题模型对照、其余 39 个 Provider 认证、macOS 正式支持和完整 Web 开发环境仍按路线图后续推进。
- 覆盖率继续执行双平台不下降门禁；全仓 80% 与关键安全分支 90% 仍是后续提升目标，不以降低阈值换取通过。

## 0.3.0-rc.1 — 2026-08-12

### 收口与发布准备

- 将根清单、8 个公开 npm 包、内部精确依赖、锁文件和 Python SDK 同步为 npm `0.3.0-rc.1` / Python `0.3.0rc1`。
- 新增 0.2→0.3 双语迁移指南、双语已知限制、21 个模块的 SOP/Skill 双语索引，并同步根 README、公开路线图、Provider 状态和发布 SOP。
- `.gitignore` 补充虚拟环境、类型检查、覆盖率和本机 Registry 凭据边界；源码包仍排除内部分析、交接、会话、运行证据、密钥、缓存和构建产物。
- Markdown 审计新增中英文段落边界门禁；双语包 README 改为独立语言章节，避免在同一描述中先中文后附英文译文。
- 双平台 CI 的 checkout 改为完整历史，确保冻结基线能读取不可变的 `v0.2.0-rc.1` Tag；新增工作流合同测试阻止浅克隆配置回归。
- CI 与文档工作流复用统一的当前 Action 固定提交，消除旧运行时弃用警告；所有外部 Action 继续固定完整提交哈希。
- 冻结基线命令现在会先重建 8 个正式包，再采集公开类型合同，避免旧 `dist` 掩盖源码类型漂移；Runtime 的拒绝停止钩子保持内部封装，不扩大公开 API。

### 当前验证证据

- RC 自动矩阵 P01～P19 的测试锚点已同步；全仓 69 个测试文件通过、1 个按条件跳过，466 项测试通过、4 项按条件跳过；Python SDK 与真实捆绑 Worker 10/10；离线 Coding Eval 6/6。
- Windows P20 首轮发现人工拒绝后模型会把拒绝当成普通工具错误并重复申请审批。Runtime 现在会阻断被拒绝的工具和本批次尚未审批的后续工具，在本批结果归并后返回 `paused`；不会进入下一轮模型请求。若拒绝发生在顺序工作流中，当前步骤不会保存输出，后续步骤也不会启动。单工具、混合工具和两步工作流回归均为零写入副作用。
- 修复后的产品源码已完成三轮稳定性验证且零漂移；加入确定性的发布模板版本契约后，最终仓库套件为 466 项通过、4 项条件跳过。覆盖率 lines 75.83%、statements 73.93%、functions 83.19%、branches 66.96%，不下降门禁通过。总体 80% 与部分关键安全分支 90% 仍是长期目标。
- 8 个 npm tarball 均通过内容 allowlist、publint、类型解析、全新项目安装和 ESM 导入；CLI 报告 `coremind v0.3.0-rc.1`。
- Python wheel 通过内容检查、全新虚拟环境安装、版本一致性和内置 Worker 启动；独立源码 ZIP 在隔离目录完成安装、构建、合同检查和 CLI 启动。
- 21 个模块、5 个黄金示例、14 组文档站双语材料和 410 个 Markdown 文件通过合同、严格 UTF-8、本地链接、公开标识与中英文段落边界检查。
- `alibaba-model-studio/qwen-plus` 已基于 `0.3.0-rc.1` 完成流式、工具调用、结构化结果、多轮、中止、错误映射和长上下文七项真实复验；脱敏证据不包含密钥、提示原文或回复正文。

### 发布门禁

- Windows/Linux P20 真实 TTY 证据必须绑定同一最终源码提交，历史 `0.2.0-rc.1` 证据不能复用；合并与 Tag 不能改变已验收的源码内容。
- 40 个 Provider 均可配置，其中 1 个已完成 `0.3.0-rc.1` 七项真实复验，另外 39 个仍为可配置但未认证；发布前仍要求最终源码提交的双平台 CI 全绿。
- 二期真实外部同题模型对照经维护者批准延期，不用离线 6/6 替代真实模型质量结论。
- 只有上述门禁全部满足并完成最终无脏工作区预检，才能创建 Tag 并发布 GitHub Release、npm 或 PyPI。

## 0.3.0-beta.2 — 2026-08-11（源码候选，未发布）

### 新增

- 生命周期扩展只开放 `before-model`、`before-tool`、`after-tool`、`run-finished` 四个事件；扩展需显式声明信任、能力和授权，默认不加载未知项目扩展。
- 新增 experiment → arm → run → trace 轻量实验合同，记录版本、环境、输入指纹、随机种子、运行、完整 Trace 和既有 grader 结果。
- 新增 `RunResult.snapshot` 与 Protocol 校验，CLI、Worker、TypeScript、Python 共用 operation、outcome、指标、评测、Trace、Checkpoint、Artifact、扩展收据和恢复判断。
- TUI 新增 `/artifacts` 与 `/context`，`/status` 同时展示运行终态、恢复、压缩、产物和评测状态。
- Provider 认证升级为流式、工具调用、结构化结果、多轮、abort、错误映射、长上下文七项合同；旧五项证据保留追溯但不再标记当前认证。
- 新增第 21 个能力模块“Runtime 生命周期扩展”，并同步更新恢复、评测、Provider、CLI 与双 SDK 模块的 SOP、Skill、中英文指南和示例。

### 安全、证据与边界

- 扩展只能拒绝工具，不能批准被权限层拒绝的操作；扩展超时或异常不能绕过权限、Checkpoint 或改写真实终态。
- 定向核心/协议/CLI 88/88，Python SDK 与真实 Worker 10/10，Coding Eval 6/6；全仓 458 项通过、4 项按条件跳过。
- 覆盖率 lines 75.76%、statements 73.86%、functions 83.13%、branches 66.85%，不下降门禁通过；总体 80% 和部分关键安全分支 90% 长期目标仍未达到。
- 当前 40 个 Provider 均可配置，但尚无条目完成新版七项真实复验；Linux CI、双平台真实 TTY 和真实 Provider 复验仍属于 RC 前置条件。
- 本候选不增加 Web UI、独立 Python Loop、扩展市场或第二套运行终态。

## 0.3.0-beta.1 — 2026-08-11（源码候选，未发布）

### 新增

- 编码能力从示例组合升级为 Runtime 内的第一方 Engineering Kernel，公开仓库探测、用户显式环境选择、Repo Map、六阶段工程计划、有界 verify/repair Loop 与交付证据接口。
- 标准化 read/search/write/edit/process/Git 工具合同；所有文件变更必须关联写前 checkpoint，进程与网络继续复用通用权限边界。
- TypeScript 与 Python 在既有真实单文件缺陷评测之外，新增跨文件缺陷、错误命令、审批拒绝、中止、Diff 与 Restore 确定性门禁。

### 证据与边界

- 全仓 443 项通过、4 项按条件跳过；Coding Eval 6/6；Coding Kernel 行覆盖率 92.45%、分支覆盖率 87.12%。
- 未运行或失败的测试不能被声明为通过；语言、包管理器或测试命令有歧义时必须由用户选择。
- 本候选未新增浏览器自动化、桌面控制、LSP 集群、工作树编排或扩展市场；Config v2、Protocol v1 与通用终态保持不变。

## 0.3.0-alpha.3 — 2026-08-11（源码候选，未发布）

### 新增

- 新增逐字节稳定的上下文前缀与 SHA-256 指纹，固定核心规则、项目指令、工具、稳定事实和 Skill 的顺序。
- 新增受控 Artifact Store：大输出以流式方式保存到工作区，模型只看到有界头尾、摘要、哈希和相对引用。
- 新增 Context/Artifact 指标、真实缓存读写 token、离线策略对照，以及第 20 个双语能力模块。

### 安全与兼容

- 疑似凭据不会进入模型预览或 Artifact；不受信任的完整输出路径不会被读取或删除；Artifact 真实路径不能逃逸工作区。
- Config v2 与 Protocol v1 请求不变；`RunMetrics.context`、`RunMetrics.artifacts` 与 `RunResult.artifacts` 均为新增可选字段，Runtime 正常返回这些证据。
- 默认仍使用本地确定性压缩，不自动创建项目 Memory；候选压缩只产生对照数据，不自动切换。

## 0.3.0-alpha.2 — 2026-08-10（源码候选，未发布）

### 新增

- 新增 durable operation 外围状态与 `RunResult.operation`，统一 CLI、TUI、TypeScript 与 Python 对运行状态的读取。
- 新增 Memory/JSONL Session 双后端合同、RunState 故障注入、并发 writer 与不完整尾行恢复测试。
- 新增第 19 个能力模块“持久运行与故障恢复”，包含双语 README/GUIDE/SOP、Skill、示例和迁移/回滚说明。

### 变更

- RunState 使用单 writer 锁、连续序号和临时文件原子发布；只自动修复有完整前序记录的不完整最后一行。
- 工具调用、Effect Receipt、Checkpoint、operation 与终态通过 run/call/幂等关联键串联；不确定或未稳定归属的副作用不会自动重放。
- 旧 schema v3 Session 首次打开前自动生成 `.v3.backup`，迁移可重复执行；无法无损表达时保留原文件并失败关闭。

### 兼容与回滚

- Config v2 与 Protocol v1 请求保持不变；CLI `run_result` 只新增 `operation` 字段，既有字段和退出码保留。
- 终态 operation 不允许 resume。旧 Session 可按迁移指南从备份回滚，外部副作用仍需业务系统提供幂等或人工核验。

## 0.3.0-alpha.1 — 2026-08-10（源码候选，未发布）

### 新增

- 新增 CoreMind 自有 Runtime 兼容层报告，可通过 TypeScript SDK 与 `coremind doctor` 检查依赖族、Adapter、错误映射和关键能力。
- 新增不可变参考基线与独立候选基线；候选更新必须记录明确原因，不能覆盖 `0.2.0-rc.1` 参考证据。
- 新增依赖锁步、完整性报告和 CI 门禁；当前源码候选包含 39 个继承 Provider 与 1 个 CoreMind 原生入口。

### 变更

- 三个关键运行依赖统一为同一精确版本族，删除跨版本工具类型桥接。
- Session 适配到版本化仓库接口，同时保留 `session.dir/<id>.jsonl` 公共路径和损坏文件显式失败语义；旧布局备份与幂等迁移已在后续 alpha.2 候选交付。
- 新增第 18 个能力模块“Runtime 依赖 Adapter”，同步提供测试、双语 README/GUIDE/SOP、Skill、示例和迁移指南。

### 兼容与回滚

- Config v2、Protocol v1、RunOutcome、权限、Checkpoint 和恢复语义保持不变。
- 若消息、工具、Usage、错误或 Session 合同出现不可适配漂移，必须整体回退关键依赖版本族，禁止混搭。

## 0.2.0-rc.1 — 2026-08-09

### 新增与修复

- Runtime、ChatSession 和 CLI 统一返回成功、失败、暂停、中止、超时与预算耗尽终态；CLI 提供稳定退出码，JSONL 最后一行固定为 `run_result`。
- `--print` 与 `--json-events` 互斥，避免普通文本污染自动化输出。
- 自定义工具必须声明结构化副作用；权限层递归检查嵌套路径与 URL，拒绝绝对路径、盘符、UNC、目录链接逃逸和内置工具名冲突，未知副作用在受约束模式下安全拒绝。
- Windows 宿主 Shell 新增明确的三项开放门禁：仅在 full、关闭工作区限制、允许网络同时满足时执行；其他组合安全拒绝。
- TUI 审批优先显示副作用、完整目标和原因，长正文只显示摘要，凭据字段自动隐藏。
- checkpoint 记录工具完成后的文件指纹；恢复前若检测到人工或并发修改，则拒绝覆盖。
- Python SDK 在初始化或工具注册失败时立即关闭 Worker，不遗留占用临时目录的子进程。
- 8 个公开 npm 包新增发布文件 allowlist、测试产物拦截、publint、类型解析与全新项目安装验证；CLI 包不再包含 `.test.tsx` 的声明或 source map。
- 候选源码 ZIP 使用临时 Git 索引生成，不改变真实暂存区；内部计划、运行状态、缓存、凭据和本机路径会被拒绝。ZIP 读取与解压使用跨平台库并拒绝路径穿越，不再依赖不同操作系统对 `tar` 读取 ZIP 的兼容性；解压后必须完成全新安装、构建、合同检查和 CLI 启动。
- 一期源码边界移除标注为“用完即弃”的二期 Web 占位原型，并在 `.gitignore` 明确排除本地智能体设置、内部计划、运行数据、缓存、构建产物与该原型目录；CLI、SDK、Runtime、示例和贡献材料保持完整。
- Python wheel 新增内容清单、Twine、全新虚拟环境安装、公开版本一致性和内置 Worker 启动门禁，并修复 SDK `__version__` 仍指向旧版本的问题。
- Windows/Linux CI 新增全量测试三连跑与覆盖率不下降门禁；平台专属安全测试使用各自的全仓基线，关键 Runtime 模块继续共用严格底线，低于全仓 80% 和关键模块分支 90% 的差距会明确报告而不会伪装达标。Windows Shell 探测改为可注入、跨平台可复现的用例；真实宿主 Shell 集成在普通并行项目完成后由独立单 Worker Project 执行，并为托管 Windows 首次进程启动保留独立 60 秒外层 Harness，产品超时语义由 ProcessRunner 单测独立验证，不修改 Runtime 预算。属性测试固定种子并为关键安全分支增加确定性回归，避免同一提交因 Runner 环境或随机样本产生覆盖率漂移。
- 统一发布工作流在 GitHub Release 创建成功后显式从 `main` 派发双语文档部署；手动创建 Release 时仍保留事件回退路径，避免工作流令牌事件抑制或 Tag 引用导致 Pages 未更新。
- 新增公开 `loop` 配置：支持可选规划、执行、验证、修复、最大迭代、最大修复、重复动作检测，以及失败与耗尽策略；`workflow` 与 `loop` 明确互斥。
- 新增隐藏在 `LoopController` 后方的版本化状态机适配，稳定状态逐次持久化；暂停、恢复、中止、超时和预算耗尽均保留一致终态，内部依赖不扩散到配置、协议或 SDK。
- verify 未通过时必须修复、暂停或失败；修复通过后才成功。TUI、无头 CLI、TypeScript SDK 与 Python SDK 共享相同 Loop 状态顺序与 RunOutcome。
- Provider/网络瞬态错误使用统一分类和全局有界重试；审批拒绝、安全拒绝、参数错误与确定性业务失败不盲目重试。Workflow 重试耗尽现在返回 `retry_exhausted`，不再接受已知不合格输出。
- 工具调用新增 `started`、`committed`、`unknown` Effect Receipt。恢复时完整步骤和已提交副作用不重复执行，未知副作用转人工核对。
- Context 压缩失败新增 `context_compaction_failed` 事件；确定性摘要必须保留目标、约束、权限、已修改文件、测试状态和下一步。
- 新增双语“验证修复 Loop”黄金示例，确定性覆盖首次验证失败、修复后通过、暂停恢复和耗尽失败；黄金示例总数增加到 5 个。
- 当前候选覆盖率：Windows lines 72.82%、statements 70.80%、functions 80.32%、branches 63.30%；Linux lines 73.26%、statements 71.19%、functions 81.00%、branches 63.23%。ToolPolicy 分支 86.23%、Host Shell 分支 70.58%、LoopController 分支 100%、LoopRunner 分支 92.4%、Checkpoint 分支 75.4%；通用回退基线取两种正式平台的逐项最小值。
- 新增 `ProcessRunner`：使用命令与参数数组执行跨平台子进程，支持流式输出、超时、中止、输出上限和受控环境变量；显式环境不会重新合并宿主密钥。宿主 Shell 现在也以调用方显式提供的最小环境为权威，不再被工具执行上下文中的环境覆盖。
- 新增只读 `GitAdapter` 的 status/diff/log 工具，以及带输入、输出、复杂度和路径上限的统一 Diff；不开放任意 Git 子命令或仓库写操作。
- Windows 宿主 Shell 选择会排除不可用的系统转发器，优先发现真实 Git Bash，并保留 full、工作区与网络三项同时开放才可执行的策略。
- 评测 schemaVersion 2 新增 outcome、trajectory、command、file、diff、state、response 七类 grader；既有脏工作区、受保护文件、允许修改路径和最终测试可共同进入发布证据。
- 新增 TypeScript 与 Python 真实缺陷仓库：确定性离线评测 2/2；真实模型每种语言运行 5 次，能力与安全均为 5/5，工具轨迹、最终测试、差异和复核结论一致。
- 新增路径、权限、终态、中止和重复动作属性测试；预期测试失败与不可自动回退进程警告不再误记为安全发现。
- 能力模块增加到 17 个，新增编码智能体双语 README、SOP、指南、Skill 和示例。
- Release Candidate 版本同步器会统一根清单、8 个 npm 包、内部精确依赖、锁文件与 Python PEP 440 版本；当前候选为 npm `0.2.0-rc.1` / Python `0.2.0rc1`。
- Release Please 只生成草稿发布 PR；统一发布工作流从一个干净 Tag 构建一次 npm tarball、wheel 与独立源码 ZIP，经受保护 OIDC 环境发布 npm/PyPI，并生成 SHA-256 清单和 GitHub 构建来源证明。
- Python 发布工具链使用当前可用且未撤回的 `build==1.5.0`；工作流合同拒绝已撤回版本，工具版本变化后必须重跑 wheel 与发布物门禁。
- GitHub Actions 全部固定到已核对的完整提交 SHA，由 Dependabot 每周维护 Action、npm 与 Python 依赖；每个下载发布物的作业都在使用前独立校验 SHA-256。
- 新增 P01～P20 RC 验收矩阵：P01～P19 必须同时通过完整套件与逐 Case 测试锚点，P20 的 Windows/Linux 真实 TTY 证据必须绑定相同版本和提交。
- 新增全仓 Markdown 审计，检查 350 余个项目文档的严格 UTF-8、本地链接和文档标识边界；依赖、缓存与构建产物明确排除。
- 本地 `.scratch` 继续用于验收证据和隔离工具环境，并同时排除在 Git、静态检查和发布物之外，避免第三方临时文件污染仓库门禁。
- Trace 与 RunState 持久化前隐藏凭据字段、正文、命令敏感参数和 URL 密钥，同时保留路径与非敏感测试命令供审计和轨迹 grader 使用。
- Agent 工具循环新增连续两次工具调用结果均回灌后再结束的回归测试，避免用单次工具调用代替 P02 多工具证据。
- 长链路 Runtime 测试项目显式使用 15 秒 Harness 外层上限，高于产品自身最长 10 秒的受控进程超时；CLI 子进程项目继续使用 30 秒上限。项目级配置避免 Vitest 多项目模式回退到 5 秒默认值，在高负载 Runner 上抢先误判失败；Runtime 预算不变。
- Provider 真实认证现在强制完成至少三轮上下文验证，并在写入证据前校验五项检查和 CoreMind 版本；认证矩阵也会拒绝缺少版本的台账并公开显示认证版本。`alibaba-model-studio/qwen-plus` 已基于 `0.2.0-rc.1` 重新通过五项真实复验，证据仅保留脱敏摘要。
- `doctor <配置文件>` 现在优先检查配置声明的 `provider.apiKeyEnv`，不会再因无关 Provider 的固定密钥清单产生假失败；未显式声明时也会识别 Alibaba 入口的默认变量。

## 0.2.0-beta.2 — 2026-08-08

### 修复

- 全屏 TUI 在生成过程中能够识别 `/abort`，不再被忙碌状态静默忽略。
- 所有工具请求均被拒绝且没有成功工具结果时，运行返回 `paused`，不再错误显示为成功。
- `run` 或 `chat` 使用 `--session` 但配置未启用 Session 时明确失败，并提示设置 `session.enabled: true`。

## 0.2.0-beta.1 — 2026-08-08

### 新增

- Config v2、Protocol v1，以及一致的 TypeScript/Python SDK 运行语义。
- 有预算、权限、Trace、RunState、Checkpoint、恢复和质量门禁的受控执行循环。
- CLI/TUI 的 `create`、`run`、`chat`、`check`、`eval`、`doctor` 和模板入口。
- 16 个功能模块与 4 个黄金示例，每个模块包含双语 README、GUIDE、SOP、Skill 和测试入口。
- 双语文档站、社区治理文件、Issue/PR 模板和 npm/PyPI 发布预检。
- 38 个可配置 Provider 入口及证据驱动认证矩阵；阿里云模型服务 `qwen-plus` 完成五项真实认证。
- Linux 内置 Shell 的操作系统级隔离、断网和工作区写入限制；隔离不可用时失败关闭。

### 安全与兼容性

- 生产依赖审计为 0 个已知漏洞。
- 文档工具的已知开发服务器风险通过移除服务器命令、仅静态构建和带到期日的风险策略隔离。
- Windows 一期没有与 Linux 对等的操作系统级 Shell 隔离；macOS 尚未正式支持。

### 升级说明

这是从 `0.1.0-alpha.2` 到新公共合同的 Beta 升级。请重新生成项目配置并运行 `coremind check`；不要假设旧 Alpha 配置、结果字段或恢复状态可以直接复用。
