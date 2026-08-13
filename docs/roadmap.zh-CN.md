# CoreMind 公开路线图

CoreMind 面向没有智能体开发经验的新手和普通工程师，通过配置、标准 Runtime、受控 Harness/Loop、质量门禁和配套学习材料，帮助用户更快构建可靠的业务智能体。

本路线图用于说明公开版本的能力边界和建设方向，不包含内部排期、验收记录或维护者工作笔记。具体优先级会根据真实用户反馈和社区贡献调整。

## 当前稳定候选：`0.3.0`（尚未发布）

`0.2.0-rc.1` 保持为不可变参考基线；GitHub Release、npm 与 PyPI 决定各渠道实际可安装的最新版本。当前 `0.3.0` 稳定候选完整继承 rc.2 的以下能力：

- CLI/TUI、TypeScript SDK、Python SDK 和完整源码三种使用路径。
- 单智能体、多智能体、Workflow 和有预算约束的 Loop。
- Config v2、40 个可配置模型供应商及自定义兼容端点。
- `ask`、`assisted`、`full` 三档权限，以及路径策略、审批、审计、checkpoint、diff 和恢复。
- 明确的运行结果、预算、Trace、Session、Context 保护、测试、评测和发布门禁。
- 8 个项目模板、5 个离线黄金示例、2 个编码智能体真实缺陷仓库和 21 个能力模块。
- 每个能力模块配套测试、SOP、Skill、中英文指南和示例。
- Windows/Linux 自动化与双平台真实伪终端相结合的验收流程，以及 GitHub、npm、PyPI 和双语文档站同步发布流程。

当前源码版本尚未公开发布。rc.2 的 CLI、TypeScript SDK、Python SDK、独立源码包和 Windows TUI 已完成受控 Dogfooding，未发现稳定版硬阻断；稳定候选仍须完成自动门禁、Provider 复验、精确 main、最终人工验收和 Release Readiness。

它包含显式 `loop` 配置、verify/repair 状态、稳定快照、暂停恢复、Effect Receipt、有界重试、第五个验证修复黄金示例，以及编码智能体所需的受控进程、只读 Git、统一 Diff、七类 grader 和 TypeScript/Python 真实缺陷评测。每个候选都要在同一提交完成自动质量门禁、双平台 P01～P20、真实 Provider 复验和最终文档审计后才能同步发布。

## `0.3.x`：当前稳定迭代

当前稳定线聚焦 `0.3.0-rc.2` 已交付能力在 `0.3.0` 候选中的可靠性和可用性：

- 持续改善 Windows/Linux TUI 的交互体验与终端兼容性。
- 根据首次社区试用修复安装、配置、错误提示和交互体验问题。
- 扩充经过真实调用验证的模型供应商认证证据。
- 持续验证 CLI、TypeScript SDK 和 Python SDK 的结果与事件一致性。
- 持续把显式有界 Loop、Harness 与编码智能体证据纳入跨平台 Release Candidate 验收。
- 加强安全、恢复、评测、文档和公开包的发布回归。

未经过真实测试的能力只标记为可配置，不标记为官方认证。

## `0.3.0`：二期内核与工程闭环

二期沿 `alpha → beta → rc` 建设框架内核，不改变 CoreMind 的三种使用方式：

- 统一关键依赖版本，通过私有 Adapter 隔离低层实现与公开合同。
- 建立可持久化、可中止、可暂停、可恢复且不重复副作用的 Harness 操作模型。
- 增强 Context 选择、压缩证据、长输出 Artifact 和可观测指标。
- 把 Coding/Engineering Kernel 建设为第一方核心内核，覆盖仓库理解、最小修改、Diff、验证、修复和回归。
- 保持 TUI、无头 CLI、TypeScript SDK 与 Python SDK 的终态、事件、审批和恢复一致。
- 为每批能力同步提供测试、SOP、Skill、中英文指南、示例、迁移与回滚说明。

`0.3.0-rc.2` 已完成 Batch 0～6：关键依赖保持同一精确版本族并由私有 Adapter 隔离；运行具备 durable operation、原子 RunState、Session 双后端合同、自动备份迁移和副作用不重放边界；长任务具备稳定上下文前缀、确定性压缩证据、真实缓存指标和工作区内受控 Artifact；编码能力是 Runtime 内第一方 Engineering Kernel；扩展面只开放四个受控生命周期事件，并提供可追踪轻量实验、七项 Provider 认证合同、TUI 运行证据视图和四入口共享 `RunSnapshot`。当前 `0.3.0` 候选不新增产品行为，只同步稳定版本与发布材料；公开可用状态、候选 Provider 证据和最终发布资产始终以当前证据台账、Release 与 Registry 为准。

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
