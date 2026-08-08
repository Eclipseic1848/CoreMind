# CoreMind 后续迭代与 2026-08-31 发布方案

> 状态：经需求访谈确认的权威规划基线
> 确认日期：2026-08-07
> 一期截止日期：2026-08-31
> 适用范围：CoreMind Runtime、CLI/TUI、TypeScript SDK、Python SDK、模板、SOP、Skill、双语文档和社区发布
> 变更规则：任何范围、接口、结果语义、权限、安全门禁或发布日期变化，都必须先由用户确认并同步更新本文档与 handoff.md。

## 1. 产品定位

CoreMind 是一个面向没有 Agent 开发经验的新手和普通工程师的配置驱动 Agent 工程框架。

它通过标准项目结构、可靠 Harness/Loop、开发工具、质量门禁、SOP、Skill 和示例提升 Agent 开发效率并减少工程踩坑。

CoreMind 不负责替用户完成全部业务开发，也不替用户决定使用单 Agent、Workflow 还是自主 Loop。

### 1.1 职责边界

CoreMind 负责：

- 提供单 Agent、Workflow、Loop、多 Agent 等框架能力。
- 保证 Runtime 结果、错误和停止语义可信。
- 提供安全默认值、权限、预算、checkpoint、审计和恢复。
- 提供配置校验、调试、Trace、测试与评测工具。
- 提供模板、SOP、Skill、开发指南和示例。
- 提供项目脚手架和业务代码骨架，但不虚构业务规则或外部接口。

用户负责：

- 明确业务目标、规则和验收标准。
- 决定 Agent 架构、模型、工具、Workflow 和自治程度。
- 提供数据库、外部接口和真实业务信息。
- 实现或确认具体业务逻辑。
- 判断业务结果是否正确，并决定是否上线。

核心原则：CoreMind 管机制和工程质量，用户管业务方向和架构选择。

## 2. 三种官方使用路径

CoreMind 提供三种渐进式使用路径：

    CLI/TUI 配置使用
            ↓
    TypeScript/Python SDK 业务扩展
            ↓
    源码级深度定制

三种方式必须共用一个 Runtime：

    CLI/TUI ───────────────────┐
    TypeScript SDK ────────────┼→ CoreMind 公共接口
    Python SDK → Protocol Adapter ┘
                                      ↓
                             CoreMind Runtime
                        ┌─────────────┼─────────────┐
                     Harness      Tool Policy    RunState
                        │             │              │
                CoreMind Loop    权限/隔离/审计   会话/恢复

### 2.1 公共接口原则

- coremind-ai 是 TypeScript 用户的主要公共接口。
- coremind-cli 必须通过 coremind-ai 调用 Runtime，不得绕过门面直接依赖内部实现。
- Python SDK 通过语言无关的 CoreMind Protocol 调用同一个 Node Runtime。
- 不重新实现纯 Python Agent Loop。
- 公共接口不泄漏底层运行库的内部类型。
- config、runtime、tools、templates 等实现模块可以独立维护，但不同时扩大为大量稳定公共接口。
- 只有真实存在两个及以上 Adapter 时才建立 seam；优先建立 Tool Policy、RunStore、Trace Exporter 和跨语言 Protocol 等真实 seam。

## 3. 已确认的产品决策

- 场景不限定，优先建设通用底座。
- 官方学习路径为 CLI 配置使用 → SDK 业务扩展 → 源码深度定制。
- CLI/TUI 面向新手，SDK 面向普通工程师，源码面向高级开发者和社区贡献者。
- 官方为每个用户能力模块维护 SOP、Skill 和中英文指导材料。
- 创建用户项目时也生成项目级 SOP、Skill、测试骨架和开发指导。
- 项目材料采用标准模板与交互式信息收集相结合的方式生成，业务内容必须由用户确认。
- CoreMind 生成可运行的标准骨架并辅助开发，但不承诺自动完成全部业务 Agent。
- 支持新项目和已有 TypeScript、JavaScript、Python 工程。
- 空项目先询问用户选择 TypeScript、JavaScript 或 Python；已有项目自动检测语言。
- TypeScript SDK 与 Python SDK从下一阶段同步建设、同步发布。
- Python SDK 使用统一 Node Runtime，通过协议调用；不建设第二套纯 Python Runtime。
- 本地模型、云模型、私有模型和完全本地数据策略都需要支持。
- 继承锁定运行时依赖的全部 Provider，只对经过 CoreMind 真实测试的 Provider 标记官方认证。
- 正式支持 Windows 和 Linux；macOS 仅在文档中说明后续支持。
- Windows 与 Linux 使用统一权限语义，但允许不同底层隔离实现。
- 数据、Prompt、工具参数、Trace 和评测结果默认保存在用户环境；只有明确授权后才允许外传。
- 社区可以贡献 Runtime、SDK、CLI、模板和文档，但必须经过测试和维护者审核。
- 当前没有正式用户，允许在 Alpha 阶段进行一次不保留旧接口的架构整理。
- 架构整理后开始配置版本化；进入试用后再建立兼容和迁移承诺。
- 每个功能模块的代码、测试、SOP、Skill、指南和示例必须同步变更，否则 CI 阻止发布。
- 所有材料同时提供简体中文和英文。
- Skill 采用一份通用 SKILL.md 加少量 Codex/Claude Code 平台适配，不复制整套业务内容。
- 修改已有工程时，无论权限模式如何，都必须保留 Git 状态、diff、checkpoint、审计和回退能力。
- Web 完整开发环境放入二期。
- 一期不提供 CoreMind 官方 API 平台，不发布官方 Docker 镜像；用户通过 SDK 自建服务和 Docker。

## 4. 当前项目基线

截至 2026-08-07，本地重新验证：

- 现有 6 个 npm 包，版本为 0.1.0-alpha.2。
- CLI 已有 create、run、chat、list-templates、doctor。
- 已有 Ink TUI、YAML/JSON 配置、Provider、工具、多 Agent、顺序/并行/条件 Workflow。
- 已有 8 个场景模板，以及基础 Session、事件和质量统计。
- build 和 typecheck 通过。
- Vitest 为 115 passed、2 skipped，共 117 项。
- Biome 当前有 2 个未使用代码警告。
- TUI 渲染冒烟已过，但 Windows/Linux 真实人工交互尚未验收。
- 仓库中没有被 Git 跟踪的正式 SKILL.md 和 SOP。
- 尚无 Python SDK、CoreMind Protocol、PyPI 发布链、双语文档站和 Windows CI。
- 当前 CI 只覆盖 Ubuntu + Node。

### 4.1 必须先修复的正确性问题

1. Workflow 中 agent.prompt() 异常被吞掉，仍可能产生 step_end ok:true。
2. 上游 stopReason:error 或 Provider 失败仍可能返回 resolved。
3. Agent 工具事件绕过 run() 内部收集器，质量统计可能为零。
4. ChatSession 返回累计历史，不是本轮回答。
5. Session 恢复异常被静默降级为新会话。
6. 当前 RunQuality 混合了结果、指标和质量含义。
7. Context 只在运行结束后压缩，无法保护单次长 Loop。
8. 缺少 Agent turn、工具调用、Token、费用、工具失败和取消等多维预算。
9. 缺少统一 Tool Policy、持久化审批、RunState、可靠 checkpoint 和完整 Trace。

这些问题修复前，不发布 alpha.3，也不宣称达到生产级 Harness 或 Claude Code 水平。

## 5. 一期发布范围

一期目标日期为 2026-08-31。

建议所有交付物统一使用 0.2.0-beta.1：它们使用相同质量门禁，不存在 Preview 子模块。由于尚未经历真实用户试用，不直接标记为 1.0。

### 5.1 一期包含

- GitHub 完整开源仓库。
- npm coremind-ai TypeScript SDK。
- npm coremind-cli CLI/TUI。
- PyPI Python SDK。
- Windows 和 Linux 正式支持。
- 简体中文和英文文档网站。
- 官方模块 SOP、Skill、开发指南和示例。
- 用户项目脚手架及项目级文档生成。
- Provider 继承机制和认证矩阵。
- 三档权限模式。
- Harness/Loop 预算、错误语义、Trace、Session 和 checkpoint。
- development、standard、strict 三档质量检查。
- 社区贡献规范、PR 模板和发布流程。

### 5.2 一期明确不包含

- 完整 Web 开发环境，放到二期。
- CoreMind 官方 API 平台。
- 官方 Docker 镜像。
- 多租户 SaaS。
- 纯 Python Runtime。
- 自动替用户完成全部业务开发。
- 自动决定用户应采用哪种 Agent 架构。
- macOS 正式支持。
- 未经基准验证的 Claude Code parity 宣传。

## 6. 目标能力模块

功能模块按照用户能够独立学习和使用的能力划分，而不是按照源码目录或文件划分：

1. 项目创建：新项目、已有工程检测、语言选择。
2. 配置系统：Schema、校验、默认值、错误定位。
3. Provider：运行时 Provider 继承、认证矩阵、能力检测。
4. Agent Runtime：单 Agent 运行、错误和停止语义。
5. 工具开发：TypeScript/Python 工具和工具契约。
6. Workflow/Loop：顺序、并行、条件、重试和受控 Loop。
7. Session/Context：多轮会话、压缩和恢复。
8. 权限与安全：请求批准、帮我批准、完全访问。
9. Checkpoint：修改前快照、diff、恢复和审计。
10. Trace/调试：结构化事件、运行轨迹和错误证据。
11. 测试与评测：场景测试、业务评分和回归比较。
12. CLI/TUI：创建、运行、聊天、审批和检查。
13. TypeScript SDK：Node 应用嵌入接口。
14. Python SDK：Python 接口、协议和 Python 工具桥。
15. 模板与项目文档：示例、脚手架、项目级 SOP/Skill。
16. 源码与社区：构建、贡献、审查和发布治理。

## 7. 每个模块的强制交付合同

每个用户能力模块必须同时交付：

    模块实现
    ├─ 公共接口和错误说明
    ├─ 单元测试与集成测试
    ├─ README.zh-CN.md
    ├─ README.en.md
    ├─ SOP.zh-CN.md
    ├─ SOP.en.md
    ├─ GUIDE.zh-CN.md
    ├─ GUIDE.en.md
    ├─ skills/<module>/SKILL.md
    ├─ examples/
    └─ module.yaml

module.yaml 至少记录：

- 模块名称和版本。
- 对应源码路径。
- 中英文文档路径。
- Skill 路径。
- 示例和测试路径。
- 支持平台。
- 依赖模块。
- 当前成熟度。

CI 强制检查：

- 代码变化时配套材料是否同步。
- 中英文文件是否成对存在。
- 文档链接和示例是否有效。
- SKILL.md 是否符合通用格式并能被 Codex/Claude Code 使用。
- 示例配置是否符合当前 Schema。
- 模块版本和变更记录是否一致。

## 8. 用户项目脚手架

建议生成结构：

    my-agent/
    ├─ coremind.yaml
    ├─ src/
    │  └─ tools/
    ├─ tests/
    ├─ evals/
    │  └─ scenarios.yaml
    ├─ docs/
    │  ├─ requirements.md
    │  ├─ architecture.md
    │  ├─ development-sop.md
    │  ├─ testing-guide.md
    │  └─ acceptance-checklist.md
    ├─ skills/
    │  └─ project-agent/
    │     └─ SKILL.md
    ├─ .coremind/
    │  ├─ decisions.md
    │  └─ checkpoints/
    └─ README.md

生成规则：

- 空目录先询问 TypeScript、JavaScript 或 Python。
- 已有工程检测语言和测试框架。
- 生成配置、代码骨架、工具接口、测试骨架和明确的业务 TODO。
- 不猜测数据库字段、生产接口或审批规则。
- 用户提供信息后可以辅助补全，但必须由用户确认。
- 修改已有项目时始终记录 Git 状态、生成 diff 并保留 checkpoint。
- 完全访问只代表不逐项询问，不代表关闭审计和恢复。

## 9. Runtime/Harness 目标

### 9.1 统一结果模型

将当前 RunQuality 拆分为：

- RunOutcome：succeeded、failed、paused、aborted、finishReason、error。
- RunMetrics：duration、tokens、cost、toolCalls、retries。
- EvaluationReport：scenarioResults、qualityScores、securityFindings。
- ReleaseReadiness：ready、blockers、warnings、overrideRecord。

任何上游 stopReason:error、工具异常或 Workflow 异常都不能再返回成功。

### 9.2 CoreMind Protocol v1

协议覆盖：

- 请求和响应。
- 流式事件。
- 工具调用和 Python callable 注册。
- 用户审批。
- 取消。
- Session 和 RunState。
- checkpoint。
- 错误码。
- 协议版本协商。

本地默认采用 stdio + JSON-RPC。Python 包后台启动常驻 Node worker，而不是每次调用创建新进程。

### 9.3 三档权限模式

- ask：敏感操作前请求用户批准。
- assisted：项目内低风险修改和测试自动批准，高风险操作询问。
- full：不逐项询问，但仍执行路径保护、审计、checkpoint 和回退。

Windows 首发提供策略、工作区路径、审计和恢复保护；Linux 在此基础上增加可验证的进程或容器级 sandbox。文档必须明确平台差异。

### 9.4 受控 Harness/Loop

至少支持：

- 最大 Agent turn。
- 最大 Workflow step。
- 总超时。
- 最大工具失败次数。
- 最大重试次数。
- Token/费用预算。
- 用户取消。
- Loop 内 Context 压缩。
- 中断后恢复。
- 副作用幂等标识。
- 明确失败原因。

这些属于机制保护，不限制用户选择什么 Agent 架构。

### 9.5 Provider 策略

- 锁定具体底层运行库版本，正式发布不依赖无边界的版本漂移。
- 自动生成当前运行时 Provider 清单。
- 继承锁定运行时依赖的全部 Provider。
- 只有经过真实测试的 Provider 标记 CoreMind Certified。
- 认证测试覆盖流式响应、工具调用、结构化结果、多轮会话和错误处理。
- 没有真实密钥和测试证据时，只能标记继承支持。
- 默认无遥测；任何外传必须用户明确授权。

## 10. CLI/TUI 一期职责

建议命令：

- coremind create：创建新项目或接入已有工程。
- coremind run：无头运行，适合脚本和 CI。
- coremind chat：TUI 多轮交互。
- coremind check：配置、安全、文档和质量检查。
- coremind eval：运行场景评测。
- coremind doctor：环境和 Provider 自检。
- coremind templates：查看模板。

TUI 专注于：

- 对话和运行。
- 工具调用过程。
- 权限审批。
- 当前预算。
- 错误和恢复。
- checkpoint/diff。
- 评测摘要。

TUI 不是在线 IDE，也不承诺替用户写完全部业务代码。

## 11. 质量体系

### 11.1 三档质量级别

- development：开发调试，仅执行基础检查。
- standard：默认，适合普通业务 Agent。
- strict：增加多轮评测、故障恢复、安全测试和人工验收。

### 11.2 硬性门禁

- 配置、依赖和代码有效。
- 构建和测试通过。
- 核心业务场景达到最低评测标准。
- 失败被正确报告，不能伪装为成功。
- 无严重越权、泄密或危险工具调用。
- 权限和工具范围已配置。
- 必需 SOP、Skill、指南、示例和测试报告齐全。

高级用户可以覆盖非安全类门禁，但必须填写原因并保留审计记录。

### 11.3 评分提示

- 业务成功率和多次运行稳定性。
- Token、费用和响应时间。
- 工具调用和重试次数。
- 人工介入次数。
- 与上一版本相比是否退化。

## 12. 官方黄金示例

一期维护四个经过完整验收的黄金示例：

1. FAQ/订单助手：单 Agent、业务工具、权限和错误处理。
2. 合同审核 Agent：确定性 Workflow、结构化输出和评测。
3. 数据分析 Agent：Python SDK、Python Tool Host 和文件结果。
4. 研究/问题调查 Agent：有预算的 Loop、Context 压缩、Trace 和人工确认。

每个示例同时提供：

- TypeScript 或 Python 实现。
- 模拟数据，保证离线可跑。
- 可选真实 Provider 配置。
- 中英文教程。
- SOP 和 Skill。
- 自动测试和评测。
- 失败案例及修复指导。

## 13. 迭代批次

| 日期 | 批次 | 交付与验收 |
|---|---|---|
| 8 月 7～10 日 | Batch 0：基线止血与范围冻结 | 修复隐藏失败、统计、ChatSession、Session 恢复；清零警告；冻结一期范围和公共接口草案 |
| 8 月 11～14 日 | Batch 1：Config v2 与 Protocol v1 | 完成一次性配置重构、统一事件/错误/审批协议；CLI 只通过公共 SDK 调用 |
| 8 月 15～18 日 | Batch 2：Production Harness | RunOutcome、预算、Tool Policy、三档权限、RunState、checkpoint、Trace、Loop 内压缩 |
| 8 月 19～22 日 | Batch 3：Python SDK | PyPI 包、Node worker、stdio 协议、Python callable 工具、TypeScript/Python 契约一致性测试 |
| 8 月 23～26 日 | Batch 4：开发体验与知识体系 | CLI/TUI、质量门禁、四个黄金示例、模块 SOP/Skill/双语指南、项目级文档生成 |
| 8 月 27～28 日 | Batch 5：社区与发布工程 | 中英文文档站、贡献规范、PR 模板、Provider 认证矩阵、npm/PyPI 发布预检 |
| 8 月 29～30 日 | Release Candidate | Windows/Linux 安装、真实 TUI、真实 Provider、故障恢复、安全、双 SDK parity、干净环境验收 |
| 8 月 31 日 | 统一发布 | GitHub、npm、PyPI、文档站使用同一版本和发布说明；只有全部门禁通过才发布 |

文档、SOP 和 Skill 必须随每个批次同步产生，Batch 4 只负责整合和用户体验，不能最后补写。

## 14. 2026-08-31 发布门禁

- 构建、静态检查、类型检查零错误、零警告。
- 所有自动测试通过，无不明原因 skipped。
- Windows 和 Linux CI 全绿。
- npm 和 PyPI 在全新环境安装成功。
- CLI、TypeScript SDK、Python SDK 对相同测试场景返回等价 Outcome 和事件。
- 所有失败注入都返回明确失败，不能出现隐藏成功。
- 三种权限模式经过真实工具验证。
- checkpoint、diff 和回退测试通过。
- Session 中断恢复通过。
- 四个黄金示例通过各自评测门槛。
- 认证 Provider 有真实调用证据；未认证 Provider 不过度承诺。
- 中英文文档完整且链接有效。
- 每个功能模块具备 SOP、Skill、指南、示例和测试。
- TUI 在 Windows/Linux 完成人工交互验收。
- npm/PyPI 包不包含密钥、测试垃圾或本地路径。
- 发布前工作区状态和允许发布的文件清单明确。
- Tag、push、npm/PyPI 发布必须获得用户显式批准。

8 月 31 日是交付目标，不是降低质量门禁的理由。

## 15. 二期方向

二期建设完整 Web Agent 开发环境：

- 可视化配置 Agent、工具和 Workflow。
- 在线代码编辑。
- Trace 和调试器。
- 测试与评测面板。
- 权限审批。
- 项目文件管理。
- 发布和部署指导。

Web IDE 必须通过同一 CoreMind Protocol 调用 Runtime，不能形成第四套 Agent 引擎。

## 16. 执行优先级与变更控制

一期只抓四条主线：

1. Runtime 结果可信。
2. Harness/Loop 有安全护栏。
3. CLI、TypeScript、Python 共用同一核心。
4. 每个能力都有代码、测试、SOP、Skill 和双语指导。

执行顺序必须从 Batch 0 开始。完成 Batch 0 前，不增加模板、Web、MCP、市场或发布功能。

任何新增需求必须明确替换一期中的既有工作，不允许只增加范围而不调整日期或发布目标。

## 17. 相关证据

- 当前项目交接：handoff.md
- 原始实现计划：PLAN.md
- Phase 1 验收：docs/analysis/phase1-acceptance-review-2026-08-06.md
- Harness/Loop 调研：docs/analysis/harness-loop-research-2026-08-07.md
