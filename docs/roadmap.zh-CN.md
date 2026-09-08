# CoreMind 公开路线图

CoreMind 面向没有智能体开发经验的新手和普通工程师，通过配置、标准 Runtime、受控 Harness/Loop、质量门禁和配套学习材料，帮助用户更快构建可靠的业务智能体。

本路线图用于说明公开版本的能力边界和建设方向，不包含内部排期、验收记录或维护者工作笔记。具体优先级会根据真实用户反馈和社区贡献调整。

## 当前发布线：`0.8.0`

`0.2.0-rc.1` 保持为不可变参考基线；GitHub Release、npm 与 PyPI 决定各渠道实际可安装的最新版本。当前 `0.8.0` 发布线继承 `0.7.1`，并保留以下能力：

- CLI/TUI、TypeScript SDK、Python SDK 和完整源码三种使用路径。
- 单智能体、多智能体、Workflow 和有预算约束的 Loop。
- Config v2、40 个可配置模型供应商及自定义兼容端点。
- `ask`、`assisted`、`full` 三档权限，以及路径策略、审批、审计、checkpoint、diff 和恢复。
- 明确的运行结果、预算、Trace、Session、Context 保护、测试、评测和发布门禁。
- 8 个项目模板、5 个离线黄金示例、2 个编码智能体真实缺陷仓库和 22 个能力模块。
- 每个能力模块配套测试、SOP、Skill、中英文指南和示例。
- Windows/Linux 自动化与双平台真实伪终端相结合的验收流程，以及 GitHub、npm、PyPI 和双语文档站同步发布流程。
- Session / Run / Workspace 三个事实域的显式关联、类型化身份、I-1～I-12 不变量检查、输入收据、请求重建和取消收敛。

`v0.8.0` Tag、[GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.8.0)、8 个 npm 包与 [PyPI](https://pypi.org/project/coremind-ai/0.8.0/) 必须绑定同一版本与提交；公开可用性以实时页面为准，旧版本发布证据继续作为历史记录保留。

它包含显式 `loop` 配置、verify/repair 状态、稳定快照、暂停恢复、Effect Receipt、有界重试、第五个验证修复黄金示例，以及编码智能体所需的受控进程、只读 Git、统一 Diff、七类 grader 和 TypeScript/Python 真实缺陷评测。发布资格与 Provider 认证分别记录；仓库台账未收录 `0.8.0` 静态认证记录，正式发布还必须有同版本 strict-provider 工作流 Artifact。

## `0.8.0`：宿主验收与审查修复

Run 在成功前持久接收宿主的独立验收，拒绝后复用同 Run 的有界修正。默认工具路径、Restore 写租约、会话互斥、Run 轮数预算、Python 回调、脚本别名、TUI 结果身份、网页字节上限及 Windows 锁稳定性均已补充修复与回归。发布资格仍需当前候选的双平台、真实 Provider 与公开制品证据。MCP/LSP 与远程执行环境不属于本次交付。

## `0.7.1`：稳定性与发布证据加固

该版本不改变 Protocol wire contract。它扩展敏感 Header 别名检查，防止自定义 Provider 保存明文凭据；Artifact 导入拒绝符号链接、canonical path 越界和文件身份竞态；RunStore 正常追加只写新增 Fact；Protocol v2 长驻 Host 在终态回收幂等缓存并从权威 journal 恢复 duplicate/conflict 判断。Protocol v1 继续受支持，当前没有经批准的移除计划。

TUI 在 Run 忙碌时不再清空未发送的普通输入；发布失败会输出 P0 blockers、保留报告，并在公开产物已经创建时继续执行 Registry 回装验证。Python 包元数据与稳定版状态一致。该版本没有同版本真实 Provider 认证，旧版本网络例外和认证证据不能复用。

## `0.7.0`：Child Run 稳定版

该版本把根包、8 个 npm 包、Python SDK、bundled Worker、模块合同和发布元数据统一为 `0.7.0`。它汇总 `0.3.x-B/C` 与 Protocol v2，并增加唯一 Error Contract、Execution Security Gate，以及由 Config v2 门控、贯通 CLI/TUI/TypeScript/Python 的 Child Run 产品链路。

P0 实现、Node 22 双平台工程、候选 npm tarball、Python wheel、bundled Worker、TTY 与 Child Run 门禁已通过。严格 Provider 请求在 HTTP 响应前网络超时，维护者接受了精确绑定且仅限 `0.7.0` 的网络例外；它不是 live-provider 认证。Tag、GitHub Release、Registry 发布已完成；`0.3.2` 证据只作历史追溯。

## `0.3.x`：历史稳定性加固线

`0.3.x` 按 A → B → C 三批加固运行时语义，以兼容演进为主，不建设第二 Runtime，也不前移 Web、Jobs 或 Subagent。Config v2、Protocol v1、三档权限和现有成功路径保持兼容；为防止静默丢失、重复副作用或越权而新增的失败关闭状态必须显式、可迁移、可回滚，并通过维护者确认：

- **0.3.x-A：事实、身份与取消收敛**——声明唯一事实与派生投影（Session / Run / Workspace 三个事实域）、类型化身份与关联不变量、取消收敛与输入收据。设计与 Issues [#35～#42](https://github.com/Eclipseic1848/CoreMind/issues/35) 已完成，并随 `0.3.1` 公开发布。
- **0.3.x-B：工具与恢复**——统一 Tool Capability、显式工具阶段图与单调安全、分级 Durability Barrier、Workspace 单写者租约、持久化故障契约与正交错误结果；已随 `0.7.0` 交付。
- **0.3.x-C：证据系统**——事件回放与真实入口测试、跨模型长程 Context 生命周期、关键模块质量门、Provider 认证矩阵加固，以及“本地显性、外传明确”的可观测性基线；已随 `0.7.0` 交付。

版本号与日期不承诺；每批只有验收通过且维护者确认后才进入下一批。未经过真实测试的能力只标记为可配置，不标记为官方认证。

## 后续路线（版本范围待确认）

0.8.0聚焦宿主验收与工程审查修复。以下方向尚未交付，不再沿用早期规划中已经失效的版本分配；具体范围和验收由维护者在启动时确认：

- Web开发环境：先运行与控制面，再在线编辑、测试与评测，复用现有Protocol与Runtime。
- MCP/LSP、受控第三方插件、远程执行环境与平台生态：分别确认安全合同和兼容门禁后推进。
- 1.0目标：功能冻结、兼容与安全收口，完成正式候选和可审计发布；当前没有承诺日期。

## `0.3.0`：二期内核与工程闭环

二期沿 `alpha → beta → rc` 建设框架内核，不改变 CoreMind 的三种使用方式：

- 统一关键依赖版本，通过私有 Adapter 隔离低层实现与公开合同。
- 建立可持久化、可中止、可暂停、可恢复且不重复副作用的 Harness 操作模型。
- 增强 Context 选择、压缩证据、长输出 Artifact 和可观测指标。
- 把 Coding/Engineering Kernel 建设为第一方核心内核，覆盖仓库理解、最小修改、Diff、验证、修复和回归。
- 保持 TUI、无头 CLI、TypeScript SDK 与 Python SDK 的终态、事件、审批和恢复一致。
- 为每批能力同步提供测试、SOP、Skill、中英文指南、示例、迁移与回滚说明。

`0.3.0-rc.2` 已完成 Batch 0～6：关键依赖保持同一精确版本族并由私有 Adapter 隔离；运行具备 durable operation、原子 RunState、Session 双后端合同、自动备份迁移和副作用不重放边界；长任务具备稳定上下文前缀、确定性压缩证据、真实缓存指标和工作区内受控 Artifact；编码能力是 Runtime 内第一方 Engineering Kernel；扩展面只开放四个受控生命周期事件，并提供可追踪轻量实验、七项 Provider 认证合同、TUI 运行证据视图和四入口共享 `RunSnapshot`。`0.3.0` 稳定版不新增产品行为，只同步稳定版本与发布材料；公开可用状态、候选 Provider 证据和最终发布资产始终以当前证据台账、Release 与 Registry 为准。

二期从不可变的 `0.2.0-rc.1` 参考基线开始，冻结公开类型、Config/Protocol Schema、关键依赖组合、P01～P20、双平台行为、同题编码评测条件和质量下限。覆盖率可以提高，不能下降；任何有意合同变化都必须说明迁移与回滚，不能为通过测试而降低门槛。

## 三期：Web 开发环境

三期计划提供浏览器中的完整开发体验：

- 可视化配置智能体、工具和 Workflow。
- 在线代码编辑和项目文件管理。
- Trace 调试、测试和评测面板。
- 权限审批、运行状态和结果检查。
- 发布与部署指导。

Web 开发环境将复用 CoreMind Protocol 和现有 Runtime，不建设另一套执行引擎。

## 后续平台与生态

- 正式支持 macOS。
- 扩展社区模板、Skill、业务模块和黄金示例。
- 增加更多模型供应商的真实认证。
- 持续改善贡献者开发、测试、审查和发布体验。

新增能力仍需同步交付实现、测试、SOP、Skill、中英文指南和示例。

## 明确边界

CoreMind 不替用户决定业务目标、数据字段、审批责任或智能体架构，也不承诺自动完成所有业务开发。当前不计划提供官方托管 API、多租户 SaaS、官方 Docker 镜像或独立的纯 Python Runtime。

用户负责业务方向和最终验收；CoreMind 负责工程机制、保护边界、质量证据和开发指导。

## 参与路线图

欢迎通过 [GitHub Issues](https://github.com/Eclipseic1848/CoreMind/issues) 提交使用反馈、缺陷和能力建议。提交代码前请先阅读[贡献指南](../CONTRIBUTING.md)和[安全策略](../SECURITY.md)。
