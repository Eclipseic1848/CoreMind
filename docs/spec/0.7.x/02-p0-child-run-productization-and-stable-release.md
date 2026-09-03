# 0.7.0 P0 规格：Child Run 产品化与稳定发布

> 状态：accepted；维护者已确认规格并授权发布到 Issue Tracker
> 目标版本：`0.7.0` 稳定版
> 配套 ADR：0009～0024
> 既有内核合同：0.7.x Child Run 合同

## Problem Statement

本规格建立时，CoreMind 的公开稳定版本、仓库版本声明和源码实际能力并不一致。仓库已有 Child Run 内核合同、父子身份、预算单调性、取消传播、孤儿审计、Workspace Lease 与 Protocol v2 Projection，但配置驱动用户尚无正式 Delegation Tool，CLI、TUI、TypeScript SDK 与 Python SDK 也未形成完整且一致的 Child Run 产品流程。因此，当时的能力只能视为工程内核，不能作为稳定产品承诺。

与此同时，日常 CI 把快速工程检查、重型稳定性测试、完整 Coverage、打包、真实 TTY、Provider 认证和发布资格放在同一个双平台矩阵中。普通 PR 会承担发布候选级成本，并可能因缺少人工凭据或 Provider 证据而失败；`main` 又没有对应的强制保护规则。错误码由多个入口分别解释，实际执行入口与 `check` 命令没有共享同一套配置安全边界，导致含明文凭据的配置可能绕过预检进入 Provider 请求。

产品目标不是又一批互不相连的内核功能，而是一条可信的稳定发布路径：把 Child Run 变成默认关闭、显式授权、可观察、可恢复的正式产品能力；把错误、安全、CI、分支治理、候选验收和公开包安装证据收敛到同一个 `0.7.0` Release Closure。

## Solution

CoreMind `0.7.0` 将提供由 Config v2 门控的内置 Delegation Tool。只有活动父 Run 可以使用该工具，并且只能委派给当前父 Agent 明确允许的命名 Delegation Target。Child Run 继承项目级 Provider、canonical Workspace 和全部父级安全约束；单次委派只能提交任务、显式引用的 Fact/Artifact 以及进一步收紧的预算和限制，不能增加新的模型路由、工具、权限、路径、网络或凭据范围。

委派批准只允许创建 Child Run，不预先批准子级工具和外部 Effect。预算在创建时一次性预留，成功创建后不退款；相同 DelegationId 只做幂等查询，不自动重试。成功结果可以在 join 后接受，其他终态必须具有明确 Delegation Disposition；orphan、未知 Effect、未静止或执行所有权不明时，父 Run 必须暂停等待人工处理。

Config、Delegation Tool、Protocol v2、CLI、TUI、TypeScript SDK 与 Python SDK 将读取同一持久 Fact 和 Child Run Projection。所有执行入口在任何 Provider、工具或 Child Run 副作用前共同通过 Execution Security Gate，并从唯一 Error Contract 派生稳定错误语义。

日常 PR/main 只运行稳定命名的快速工程门；完整候选资格通过 nightly 或人工触发运行。一个顶层 P0 发布验收入口复用现有四入口等价测试、Runtime/Worker 故障测试和 RC 验收编排，并把结果绑定到同一个提交、版本和构建产物。只有该提交通过全部门禁、合入受保护的 `main`、完成真实 Provider 验收、发布 GitHub/npm/PyPI，并通过公开包回装验证，P0 才算完成。

## User Stories

1. 作为配置作者，我希望 Child Run 默认关闭，从而让现有项目升级到 `0.7.0` 时不会意外产生新的模型调用、费用或副作用。
2. 作为配置作者，我希望只能通过 Config v2 启用 Delegation Tool，从而使委派能力可以被审查、版本化和重复验证。
3. 作为配置作者，我希望为每个父 Agent 声明允许的命名 Delegation Target，从而阻止模型委派给未授权 Agent。
4. 作为配置作者，我希望为不同 Delegation Target 设置默认预算和不可突破的上限，从而控制成本、执行时间和后代规模。
5. 作为配置作者，我希望 `assisted` 模式只自动批准显式预批准的 Delegation Target，从而让便利性不扩大授权范围。
6. 作为配置作者，我希望不能在单次委派中内联新的 Agent、Provider、模型、工具或权限，从而让所有可执行 authority 都来自已审查配置。
7. 作为项目操作者，我希望 `ask` 模式中的每次委派都显示目标、任务摘要、预算和限制并等待批准，从而理解即将发生的模型活动。
8. 作为项目操作者，我希望 `full` 模式可以自动创建符合 Config 限制的 Child Run，从而在不取消安全边界的前提下运行自动化任务。
9. 作为安全审查者，我希望 Delegation Approval 只批准创建 Child Run，从而保证子级工具和外部 Effect 仍分别经过 ToolPolicy。
10. 作为安全审查者，我希望显式 deny、路径、网络、凭据和预算限制始终优先于权限模式，从而使 `full` 也不能绕过硬边界。
11. 作为父 Agent，我希望通过正式 Delegation Tool 委派任务，从而不需要调用内部 Runtime API 或启动脱离生命周期的后台进程。
12. 作为父 Agent，我希望委派只包含任务、稳定项目规则、安全约束和显式引用的 Fact/Artifact，从而避免把完整父 Session 或无关敏感内容复制给子级。
13. 作为父 Agent，我希望为一次委派进一步收紧预算和能力，从而让具体任务使用比 Config 默认值更小的权限范围。
14. 作为父 Agent，我希望相同 DelegationId 和相同输入只返回原 ChildRunId，从而在消息重放或进程恢复时不会重复执行。
15. 作为父 Agent，我希望相同 DelegationId 与不同输入被拒绝，从而避免一个身份代表两次不同执行。
16. 作为父 Agent，我希望新一次执行必须使用新 DelegationId 和新预算，从而让每次尝试都可审计。
17. 作为父 Agent，我希望成功 Child Run 的结构化结果在 join 后可直接接收，从而继续后续推理。
18. 作为父 Agent，我希望失败、取消、超时或预算耗尽的 Child Run 必须先记录明确处置，从而不会静默忽略失败。
19. 作为父 Agent，我希望只有 RecoveryDisposition 证明安全时才能重新委派，从而避免重复已提交或未知的 Effect。
20. 作为父 Agent，我希望 orphan、未知 Effect、未静止或所有权不明会暂停父 Run，从而不会在仍有未知活动时宣称成功。
21. 作为 Child Run，我希望拥有独立 RunId、Fact、预算、终态和 RecoveryDecision，从而让我的执行可以单独审计和恢复。
22. 作为 Child Run，我希望继承父级项目 Provider，从而不引入额外凭据和出站目标。
23. 作为 Child Run，我希望使用命名 Agent 已配置的模型和模型参数，从而让模型路由可预先审查。
24. 作为 Child Run，我希望单次委派不能覆盖 Provider 或模型，从而避免模型在运行时改变费用和数据边界。
25. 作为 Child Run，我希望与父级共享 canonical Workspace 和 Workspace Lease，从而让并发写入遵守同一个单 Writer 规则。
26. 作为 Child Run，我希望自己的 Checkpoint 和 EffectReceipt 保持独立归属，从而能准确回溯实际执行者。
27. 作为项目操作者，我希望父 Cancel 传播到所有活动后代并等待其收敛，从而不会留下孤儿进程或后台副作用。
28. 作为项目操作者，我希望取消 Child Run 不会自动取消父 Run，从而由父级根据结构化结果决定下一步。
29. 作为项目操作者，我希望 join timeout 会触发有界取消和清理，从而不会无限等待。
30. 作为项目操作者，我希望父或子 Worker 崩溃后先执行孤儿审计且不自动重启，从而避免重复 Provider 或工具调用。
31. 作为项目操作者，我希望 Quiescent 只在所有后代、工具、进程和关键 Fact 都已收敛后成立，从而让停止状态可信。
32. 作为 CLI 用户，我希望人类可读输出显示 Child Run 的创建、状态、目标、预算摘要、终态和待处置风险，从而不用读取内部日志。
33. 作为 CLI 自动化用户，我希望 JSON 事件包含稳定的父子身份、DelegationId、状态、Outcome 和 Recovery 信息，从而能够可靠解析。
34. 作为 TUI 用户，我希望看到可展开的 Child Run tree、当前状态、目标、预算和结果摘要，从而理解多 Agent 进度。
35. 作为 TUI 用户，我希望能对允许的审批、取消和失败处置进行交互，从而不需要退出界面处理风险。
36. 作为 TypeScript SDK 用户，我希望获得类型化的委派事件、Projection、结果和控制合同，从而在应用中集成 Child Run。
37. 作为 Python SDK 用户，我希望通过捆绑 Worker 获得与 TypeScript 相同的 Child Run 事件、Projection、结果和控制合同，从而不承担次等语义。
38. 作为 Protocol v2 客户端，我希望事件和查询从同一持久事实前缀重建 Child Run tree，从而保证实时事件和恢复查询一致。
39. 作为 Protocol v1 客户端，我希望现有非 Child Run 行为保持兼容，从而可以按既有迁移合同逐步升级。
40. 作为安全审查者，我希望所有 CoreMind 自有错误来自唯一 Error Contract，从而让 Runtime、Protocol、CLI、TUI 和 SDK 对同一错误给出相同分类。
41. 作为安全审查者，我希望未登记的自有错误码在类型检查或 CI 中失败，从而防止入口私自创造错误语义。
42. 作为项目操作者，我希望未知外部错误被规范化为 `unclassified_error` 并暂停，从而不会因错误猜测而自动重试副作用。
43. 作为审计人员，我希望历史 Fact 保留未知错误的原始值，从而可以追查 Provider 或 Adapter 的实际响应。
44. 作为配置作者，我希望明文 API key 和敏感 Header 值被所有执行入口拒绝，从而不会因为绕过 `check` 命令而泄露凭据。
45. 作为配置作者，我希望敏感值只能引用环境变量或 SecretRef，从而让配置文件可以安全进入版本控制。
46. 作为项目操作者，我希望缺失的环境变量或 SecretRef 在出站调用前失败，从而不会发送不完整或错误认证的网络请求。
47. 作为配置作者，我希望普通非敏感 Header 仍可使用字面量，从而不为无风险配置增加不必要复杂度。
48. 作为维护者，我希望 PR 和 `main` 的快速工程门在大约 20～30 分钟内完成，从而及时发现日常回归。
49. 作为维护者，我希望普通工程 CI 不依赖真实 Provider 凭据，从而不会因人工认证条件缺失而变红。
50. 作为维护者，我希望完整稳定性、Coverage、TTY、打包、重型故障和 Provider 认证保留在候选资格门中，从而不通过删减测试换取速度。
51. 作为维护者，我希望 `main` 只接受通过稳定命名工程门的 PR，从而让保护规则不会依赖易变的矩阵名称。
52. 作为维护者，我希望未解决讨论必须关闭，并禁止 force push 和删除 `main`，从而保护发布历史。
53. 作为单维护者，我希望普通合并不强制第二位批准者，从而避免仓库被治理规则锁死。
54. 作为维护者，我希望管理员紧急绕过必须记录原因，从而让例外保持可审计。
55. 作为发布负责人，我希望仓库、JavaScript 包、Python 包、文档、Changelog 和 Provider 矩阵都声明同一个 `0.7.0`，从而消除版本事实冲突。
56. 作为发布负责人，我希望一个顶层 P0 发布验收入口编排所有候选证据，从而避免人工拼接互不相关的绿测结果。
57. 作为发布负责人，我希望所有证据绑定同一提交、版本和 Runtime 摘要，从而证明测试的就是待发布产物。
58. 作为发布负责人，我希望至少一个真实 Provider 完成父调用、子调用、子级工具、结果回传和取消，从而证明离线模拟之外的产品链路。
59. 作为发布负责人，我希望候选 npm tarball 和 Python wheel 在干净环境安装并运行，从而验证发布产物而不只是源码工作区。
60. 作为发布负责人，我希望 `v0.7.0` Tag、GitHub Release、npm 和 PyPI 来自同一已验收提交，从而保持供应链一致。
61. 作为最终用户，我希望从 npm 或 PyPI 公开渠道重新安装后看到 `0.7.0` 并完成基本 Child Run 流程，从而确认发布真正可用。
62. 作为维护者，我希望任何发布门失败都会停止后续步骤，从而不会把部分成功误称为 P0 完成。

## Implementation Decisions

1. 版本目标是公开稳定版 `0.7.0`，不是 alpha、beta 或仅供内部使用的候选。根清单、所有公开 JavaScript 包、Python 包、Worker、文档、Changelog、发布元数据和示例必须使用一致版本叙事。
2. `0.7.0` 的 P0 由六个工作流组成：版本与发布事实重新定基线、日常工程 CI 与候选资格拆分、`main` 保护、Error Contract 与 Execution Security Gate、Child Run 产品化、Release Closure。它们共同构成一个发布目标，不能把其中一项局部完成解释为 P0 完成。
3. Child Run 的唯一产品发起路径是活动父 Run 内、由 Config v2 显式启用的内置 Delegation Tool。CLI、TUI 和 SDK 不提供脱离父 Run 的独立 spawn 命令或旁路创建 API。
4. Config v2 中的委派设置默认禁用。每个父 Agent 分别声明允许的命名 Delegation Target、`assisted` 模式可预批准的目标、父级委派预算池、目标默认预算和目标上限。未声明、未知、循环越权或超过限制的目标在创建前失败。
5. Delegation Target 必须引用同一项目中已声明的命名 Agent。目标可以拥有自己的模型与模型参数，但使用同一个项目级 Provider；单次委派请求不能覆盖 Agent、Provider、模型、工具、权限、路径、网络、凭据或 Workspace。
6. Delegation Tool 的可变输入仅包括任务、显式 Fact/Artifact 引用，以及比 Config 更严格的预算或限制。Runtime 必须在产生委派 Fact 前规范化输入并绑定稳定 DelegationId 与输入指纹。
7. 权限模式沿用 `ask / assisted / full`。`ask` 的每次委派都要求批准；`assisted` 只自动批准 Config 明确预批准且满足全部限制的目标；`full` 不要求逐次委派批准。任何模式都不能覆盖显式 deny 或其他硬边界。
8. Delegation Approval 只授权创建一个固定目标、固定输入指纹和固定限制的 Child Run。Child Run 后续工具、网络和外部 Effect 继续使用统一 ToolPolicy 和既有审批合同。
9. Delegated Context 只包含任务、稳定项目规则、继承的安全约束和显式引用的 Fact/Artifact。Runtime 不复制父 Session 全文，不自动加载未引用文件、凭据、完整工具输出或未知 Effect 正文；父级接收结构化 ChildRunResult 和证据引用，而不是子级完整消息树。
10. Delegation Budget 覆盖 token、工具调用、费用、wall time、步骤和后代数。创建前初始化失败可以释放预留；一旦 Child Run 成功创建，预留额度不因未使用而退款。最大深度默认 3、最大活动子级默认 4、总后代数默认 32，Config 只能收紧这些限制。
11. Child Run 继承父级 canonical Workspace，不能覆盖 cwd、路径根或 worktree。父子与兄弟共享同一 Workspace Lease 服务；并行读允许，并行写必须保持单 Writer。Checkpoint、CallId 和 EffectReceipt 归属实际执行的 Child Run，父级只持久化结果引用和 change summary。
12. 一个 DelegationId 永久表示一次委派尝试。相同身份和相同输入幂等返回原 ChildRunId；不同输入返回 conflict。系统不自动重试 Child Run。只有 RecoveryDisposition 明确允许时，父级才能在记录处置后使用新的 DelegationId 和新预算重新委派。
13. 成功 Child Run 在 join 后可以默认接受。失败、取消、超时或预算耗尽必须先持久化 Delegation Disposition，再允许父级继续、改走其他方案、重新委派或传播终态。orphan、未知 Effect、未静止或执行所有权不明强制父 Run 暂停。
14. 父 Cancel 传播到全部活动后代并等待取消、进程清理和关键 Fact flush；子 Cancel 不自动传播给父级。join timeout 触发有界取消，但 Adapter 未能收敛时不得谎报 Quiescent。
15. Protocol v2 的事件、查询与控制合同显式携带父子 Run 身份和 DelegationId，并从同一持久事实前缀重建 Child Run tree。v1 继续遵守既有迁移合同，但不新增 Child Run tree 承诺。
16. CLI 人类输出、CLI JSON 事件、TUI、TypeScript SDK 和 Python SDK 使用同一 Projection。它们必须一致呈现 Child Run 的目标、父子身份、状态、预算摘要、Outcome、Recovery 和待处置风险；TUI 可以展开 tree，并提供既有 authority 允许的审批、取消和处置交互。
17. P0 不增加独立 Child Run spawn、list、resume、detach 或跨父 Run 运维命令。SDK 的产品合同是通过正常运行观察和控制活动父子链，而不是暴露内部 Coordinator。
18. Error Contract 是 CoreMind 自有稳定错误码的唯一注册表。终态、取消、重试、Protocol、CLI、TUI、TypeScript 和 Python 映射从该注册表派生；未登记的自有字面量必须在类型检查或 CI 中失败。
19. Provider、工具和 Adapter 的未知异常规范化为已登记的 `unclassified_error`，分类为暂停、人工处理、禁止自动重试。历史 Fact 继续保存原始未知错误值用于审计。
20. 所有可能产生 Provider、工具或 Child Run 副作用的入口共同通过一个不可绕过的 Execution Security Gate，`check` 命令复用完全相同的规则。安全失败不可强制跳过。
21. 配置中的明文 API key，以及按名称不区分大小写识别的 Authorization、Proxy-Authorization、X-API-Key、Cookie 等敏感 Header 值必须被拒绝。敏感值只能引用环境变量或 SecretRef，并在 Provider Adapter 边界解析；引用缺失时必须在出站前失败。普通非敏感 Header 可以保留字面量。
22. PR 与 `main` 的快速工程门使用稳定且可被分支保护引用的检查名称，目标耗时约 20～30 分钟。它覆盖构建、类型、格式、安全、文档、核心确定性测试、关键双平台行为和 Python 一致性，但不要求人工凭据或真实 Provider。
23. nightly 或人工触发的候选资格门保留三连稳定性、完整 Coverage、打包、真实 TTY、重型故障矩阵、严格发布预检、顶层 P0 验收和真实 Provider 认证。拆分 CI 不删除任何现有测试。
24. `main` 只接受通过 PR 和必需工程检查的变更，未解决讨论必须关闭，force push 和删除被禁止。普通合并不强制第二位批准者；合并由维护者人工执行，管理员紧急绕过必须记录原因。
25. 一个顶层 P0 发布验收入口负责调度并汇总现有四入口等价测试、Runtime/Worker 故障测试和 RC 验收能力。报告必须包含版本、提交、Runtime/产物摘要、平台、每个验收项状态、失败原因和证据引用。
26. 真实 Provider 验收至少覆盖父 Agent 模型调用、Delegation Tool、Child Run 模型调用、子级工具调用、结构化结果回传和取消收敛。凭据不得进入日志、Fact、报告或构建产物；实际网络调用、凭据使用和费用在执行门前单独批准。
27. 发布前必须从候选 npm tarball 和 Python wheel 在隔离环境安装并完成版本、公开入口、Worker 和基本 Child Run 冒烟；工作区源码绿测不能替代候选包验证。
28. `v0.7.0` Tag、GitHub Release、npm 和 PyPI 必须来自同一已合入 `main` 且通过全部门禁的提交。任一步失败都停止后续步骤，不覆盖不同内容的同名产物。
29. 发布后必须从 npm 与 PyPI 公开渠道重新安装，核对版本和摘要，并完成基本运行与 Child Run 冒烟。只有发布后验证通过，Release Closure 与 P0 才能标记完成。
30. 文档必须同步说明 Config 委派设置、权限矩阵、预算、Context、失败处置、错误合同、安全配置、四入口用法、已知限制、升级路径和发布验收证据。示例不得包含明文凭据。

## Testing Decisions

测试只断言用户可观察合同：Config 是否被接受、是否发生 Provider/工具/Child Run 副作用、持久 Fact 与 Projection、稳定错误码、终态、恢复结果、界面/SDK 输出、进程是否收敛、包是否可安装以及公开产物是否一致。测试不得通过读取内部 Map、替换 Coordinator 私有方法或只匹配实现细节来证明产品行为。

P0 只新增一个顶层发布验收入口，并复用三类现有高层测试能力：四入口请求与结果等价验收；Runtime、Child Run、Protocol Host 与跨进程崩溃故障测试；现有 RC、TTY、Provider 和包验证编排。底层单元与属性测试继续保留，用于精确定位失败，但不单独构成产品验收。

顶层验收矩阵如下：

| ID | 外部行为 | 必需证据 |
| --- | --- | --- |
| P0-01 | 委派默认关闭；未知目标、非 allowlist 目标和内联 authority 扩张在创建前失败 | Config 正反例；零 Child Run Fact；零 Provider/工具副作用 |
| P0-02 | 正式 Delegation Tool 从活动父 Run 创建一个命名 Child Run | 父调用、委派 Fact、ChildRunId、结果引用与 Projection 完整关联 |
| P0-03 | `ask / assisted / full` 严格遵守委派批准矩阵，Effect 审批保持独立 | 三模式矩阵；拒绝路径；子级工具审批证据 |
| P0-04 | Delegated Context 只包含允许内容，凭据与隐式文件不泄漏 | Provider 请求摘要、Context 指纹、敏感标记负向断言 |
| P0-05 | token、工具调用、费用、wall time、步骤、深度、活动数和后代数单调收紧 | 边界值、超限拒绝、创建前释放与创建后不退款证据 |
| P0-06 | Child Run 使用项目 Provider 和目标 Agent 模型，委派不能覆盖路由 | 路由 Fact 与 Provider 请求；覆盖尝试在出站前失败 |
| P0-07 | 父子共享 canonical Workspace，单 Writer、独立 Checkpoint 和 EffectReceipt | 真实双 Writer 竞争、change summary、归属与恢复证据 |
| P0-08 | 成功 join 可继续；失败、取消、超时和预算耗尽必须先处置 | 每种终态的 ChildRunResult、Disposition Fact 与父级后续行为 |
| P0-09 | 相同 DelegationId 幂等且不重跑；新尝试需要新身份、新预算和安全 RecoveryDisposition | 重放、冲突、恢复和 Effect 次数断言 |
| P0-10 | 父 Cancel、子 Cancel、join timeout 和 Adapter 不收敛遵守取消与 Quiescent 合同 | 有界时间、进程清理、Fact flush、无悬挂后代证据 |
| P0-11 | 父崩溃、子 Worker 崩溃、Host 重启、orphan 和未知 Effect 不重复副作用 | 跨进程故障注入、marker 只写一次、暂停与孤儿审计证据 |
| P0-12 | CLI、TUI、TypeScript 与 Python 对同一 fixture 产生等价请求、Outcome 和 Child Run tree | 四入口规范化指纹、同一错误码与 Projection 比较 |
| P0-13 | Protocol v2 事件、分页查询、恢复和控制共享同一事实前缀 | Worker/Host 跨进程测试；Python bundled worker 一致性 |
| P0-14 | Error Contract 覆盖全部自有错误，未知外部错误失败关闭且不重试 | 注册表完整性、编译/CI 负例、原始错误审计值 |
| P0-15 | 所有执行入口共同拒绝明文密钥和敏感 Header，引用缺失时零出站 | run/chat/eval、TS、Python、Worker、Child Run 和 check 等价矩阵 |
| P0-16 | 快速工程门与候选资格门分离且不丢测试 | Workflow 合同、稳定检查名、测试清单守恒与实际耗时记录 |
| P0-17 | `main` 保护规则与 ADR 一致 | GitHub ruleset/branch protection 只读导出和一次受控 PR 验证 |
| P0-18 | 所有版本声明、文档和发布元数据一致为 `0.7.0` | 版本同步检查、Changelog、Provider 矩阵与发布预检 |
| P0-19 | Windows/Linux、npm tarball、Python wheel、Worker、TTY 全部通过候选包验证 | 双平台 CI、干净隔离安装、产物 SHA-256 与 TTY 证据 |
| P0-20 | 至少一个真实 Provider 完成父子调用、工具、结果和取消；`0.7.0` 仅允许下述维护者网络例外 | 绑定候选提交、版本与 Runtime 摘要的脱敏认证报告，或精确绑定失败运行、Runtime 摘要与维护者裁决的一次性网络豁免 |
| P0-21 | Tag、GitHub Release、npm、PyPI 来自同一候选提交 | 提交、Tag、产物摘要、Registry 元数据和不可覆盖检查 |
| P0-22 | 公开 npm/PyPI 包回装后版本正确且基本 Child Run 可用 | 发布后全新环境安装日志、版本输出和产品冒烟报告 |

快速工程门必须至少覆盖 P0-01、P0-03、P0-05、P0-09、P0-10、P0-12、P0-14、P0-15 的确定性代表场景，以及构建、类型、安全和文档合同。候选资格门覆盖 P0-01～P0-20；发布流程覆盖 P0-21；发布后验证覆盖 P0-22。任何必需证据缺失、提交不一致、版本不一致或人工证据未绑定候选提交时，顶层报告必须失败。

测试数据使用假 Provider、临时 Workspace 和无真实秘密的环境变量引用。真实 Provider 只出现在独立批准的候选资格运行中。所有跨平台、候选包和真实 Provider 证据都必须记录证据级别，避免把离线绿测描述为产品验收或发布完成。

### 0.7.0 Provider 网络例外

严格候选运行 `33582995518` 的 Windows 与 Ubuntu 候选矩阵成功；`alibaba-model-studio/qwen-plus` 的首个真实请求在获得 HTTP 响应前以 `provider_transient / Request timed out` 失败，自动重试为零，未生成 Provider 成功证据。维护者在 [Issue #113 裁决](https://github.com/Eclipseic1848/CoreMind/issues/113#issuecomment-5505065678)中将其作为网络例外验收通过。

该例外只适用于 `v0.7.0`，只接受原始提交 `8a3fa98b09d3fdfd8fe92ae864bea213f34f17e3`、失败运行 `33582995518`、失败 Job `100134811632` 与候选 Runtime 包摘要 `16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea`。发布提交仍须通过同提交双平台工程门、离线候选包与真实 TTY 门禁，并保持 Runtime 制品等价。该裁决不构成 live-provider 认证，不更新 Provider 成功台账，也不能被后续版本复用。

## Out of Scope

- Web 产品面与任何 Web UI 修改。
- durable detach、脱离父 Run 生命周期的后台 Child Run 或 Jobs。
- Runs 运维 CLI、独立 spawn/list/resume/detach 命令和 Supervisor。
- MCP 产品集成或把普通 MCP Tool、Workflow Step、并行 Tool Call 自动升级为 Child Run。
- 多 Provider 项目、跨 Provider 委派、委派级 Provider/模型覆盖。
- 远程执行环境、委派级 cwd、自动临时 Workspace、Git worktree 或 Workspace 合并协议。
- 自动重试 Child Run、复用 DelegationId 重跑或对成功创建后的未使用预算退款。
- 与 P0 无关的依赖升级、代码整理、模块重构或新产品功能。
- 在发布后自动开始 `0.7.1`、`0.8.0` 或其他后续版本工作。

## Further Notes

### 已验证事实

- 规格基线建立时，公开稳定版为 `0.3.1`，仓库根版本为 `0.3.2`，源码已经包含后续 0.4.x 与 0.7.x 合同。
- Child Run 内核已有身份、预算、取消、孤儿审计、Workspace Lease、Protocol v2 Projection 和跨进程故障测试，但正式非测试产品路径尚未通过 Config 门控的 Delegation Tool 发起。
- Config 现有安全检查会拒绝明文 `apiKey`，但 run/chat/eval 等实际执行入口没有全部复用该检查，任意 Header 也缺少敏感名称处理。
- 现有 CI 在每个 PR/main 的双平台矩阵中同时运行工程、稳定性、Coverage、TTY、打包与发布候选检查。
- 仓库已有四入口等价验收、Child Run/Host 故障测试和 RC 验收编排，可以作为本规格的现有高层测试切入点。

### 基于代码的推断

- 最高收益的实现方式是扩展现有 Config、Runtime、Projection、Protocol、CLI/TUI、Python Worker 和 RC 编排，而不是另建第二套 Child Run 栈。
- 一个顶层 P0 验收入口可以统一现有证据并减少重复框架，但具体任务拆分仍应在规格确认后依据模块 owner 和依赖顺序完成。
- 当前四入口等价 fixture 使用测试用明文 key；实施 Execution Security Gate 时需要改为无秘密的环境变量或 SecretRef fixture，否则测试自身会违反新合同。

### 后续执行门

- 快速工程门的 20～30 分钟目标需要在拆分后的真实 GitHub Actions 运行中测量，不能由本地估计证明。
- 真实 Provider 的具体供应商、模型、凭据、费用上限和执行时间仍由维护者在认证前确认。
- GitHub Issue 创建、分支保护修改、提交、推送、PR、合并、Provider 调用、Tag、GitHub Release、npm 与 PyPI 发布分别属于后续执行门；本规格本身不自动授权这些动作。
- 本地规格审查通过不等于实现完成、产品验收、发布资格或 Release Closure。
