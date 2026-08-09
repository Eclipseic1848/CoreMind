# CoreMind 变更日志

本文件记录面向用户的重要变化。版本遵循语义化版本；Beta 版本允许在发布说明中明确标注的接口调整。

[English](CHANGELOG.en.md)

## 未发布

### 新增与修复

- Runtime、ChatSession 和 CLI 统一返回成功、失败、暂停、中止、超时与预算耗尽终态；CLI 提供稳定退出码，JSONL 最后一行固定为 `run_result`。
- `--print` 与 `--json-events` 互斥，避免普通文本污染自动化输出。
- 自定义工具必须声明结构化副作用；权限层递归检查嵌套路径与 URL，拒绝绝对路径、盘符、UNC、目录链接逃逸和内置工具名冲突，未知副作用在受约束模式下安全拒绝。
- Windows 宿主 Shell 新增明确的三项开放门禁：仅在 full、关闭工作区限制、允许网络同时满足时执行；其他组合安全拒绝。
- TUI 审批优先显示副作用、完整目标和原因，长正文只显示摘要，凭据字段自动隐藏。
- checkpoint 记录工具完成后的文件指纹；恢复前若检测到人工或并发修改，则拒绝覆盖。
- Python SDK 在初始化或工具注册失败时立即关闭 Worker，不遗留占用临时目录的子进程。
- 8 个公开 npm 包新增发布文件 allowlist、测试产物拦截、publint、类型解析与全新项目安装验证；CLI 包不再包含 `.test.tsx` 的声明或 source map。
- 候选源码 ZIP 使用临时 Git 索引生成，不改变真实暂存区；内部计划、运行状态、缓存、凭据和本机路径会被拒绝，解压后必须完成全新安装、构建、合同检查和 CLI 启动。
- Python wheel 新增内容清单、Twine、全新虚拟环境安装、公开版本一致性和内置 Worker 启动门禁，并修复 SDK `__version__` 仍指向旧版本的问题。
- Windows/Linux CI 新增全量测试三连跑与覆盖率不下降门禁；平台专属安全测试使用各自的全仓基线，关键 Runtime 模块继续共用严格底线，低于全仓 80% 和关键模块分支 90% 的差距会明确报告而不会伪装达标。
- 文档发布工作流在 Release 事件中改为从 `main` 派发手动部署路径，避免受保护 Pages 环境在 Tag 引用上启动前失败。
- 新增公开 `loop` 配置：支持可选规划、执行、验证、修复、最大迭代、最大修复、重复动作检测，以及失败与耗尽策略；`workflow` 与 `loop` 明确互斥。
- 新增隐藏在 `LoopController` 后方的版本化状态机适配，稳定状态逐次持久化；暂停、恢复、中止、超时和预算耗尽均保留一致终态，内部依赖不扩散到配置、协议或 SDK。
- verify 未通过时必须修复、暂停或失败；修复通过后才成功。TUI、无头 CLI、TypeScript SDK 与 Python SDK 共享相同 Loop 状态顺序与 RunOutcome。
- Provider/网络瞬态错误使用统一分类和全局有界重试；审批拒绝、安全拒绝、参数错误与确定性业务失败不盲目重试。Workflow 重试耗尽现在返回 `retry_exhausted`，不再接受已知不合格输出。
- 工具调用新增 `started`、`committed`、`unknown` Effect Receipt。恢复时完整步骤和已提交副作用不重复执行，未知副作用转人工核对。
- Context 压缩失败新增 `context_compaction_failed` 事件；确定性摘要必须保留目标、约束、权限、已修改文件、测试状态和下一步。
- 新增双语“验证修复 Loop”黄金示例，确定性覆盖首次验证失败、修复后通过、暂停恢复和耗尽失败；黄金示例总数增加到 5 个。
- 覆盖率基线提升到 lines 72.31%、statements 70.37%、functions 79.66%、branches 62.47%；LoopController 分支 100%，LoopRunner 分支 92.4%，Checkpoint 分支 75.4%。
- 新增 `ProcessRunner`：使用命令与参数数组执行跨平台子进程，支持流式输出、超时、中止、输出上限和受控环境变量；显式环境不会重新合并宿主密钥。
- 新增只读 `GitAdapter` 的 status/diff/log 工具，以及带输入、输出、复杂度和路径上限的统一 Diff；不开放任意 Git 子命令或仓库写操作。
- Windows 宿主 Shell 选择会排除不可用的系统转发器，优先发现真实 Git Bash，并保留 full、工作区与网络三项同时开放才可执行的策略。
- 评测 schemaVersion 2 新增 outcome、trajectory、command、file、diff、state、response 七类 grader；既有脏工作区、受保护文件、允许修改路径和最终测试可共同进入发布证据。
- 新增 TypeScript 与 Python 真实缺陷仓库：确定性离线评测 2/2；真实模型每种语言运行 5 次，能力与安全均为 5/5，工具轨迹、最终测试、差异和复核结论一致。
- 新增路径、权限、终态、中止和重复动作属性测试；预期测试失败与不可自动回退进程警告不再误记为安全发现。
- 能力模块增加到 17 个，新增编码智能体双语 README、SOP、指南、Skill 和示例。
- Release Candidate 版本同步器会统一根清单、8 个 npm 包、内部精确依赖、锁文件与 Python PEP 440 版本；当前候选为 npm `0.2.0-rc.1` / Python `0.2.0rc1`。
- Release Please 只生成草稿发布 PR；统一发布工作流从一个干净 Tag 构建一次 npm tarball、wheel 与独立源码 ZIP，经受保护 OIDC 环境发布 npm/PyPI，并生成 SHA-256 清单和 GitHub 构建来源证明。
- GitHub Actions 全部固定到已核对的完整提交 SHA，由 Dependabot 每周维护 Action、npm 与 Python 依赖；每个下载发布物的作业都在使用前独立校验 SHA-256。
- 新增 P01～P20 RC 验收矩阵：P01～P19 必须同时通过完整套件与逐 Case 测试锚点，P20 的 Windows/Linux 真实 TTY 证据必须绑定相同版本和提交。
- 新增全仓 Markdown 审计，检查 350 余个项目文档的严格 UTF-8、本地链接和文档标识边界；依赖、缓存与构建产物明确排除。
- Trace 与 RunState 持久化前隐藏凭据字段、正文、命令敏感参数和 URL 密钥，同时保留路径与非敏感测试命令供审计和轨迹 grader 使用。
- Agent 工具循环新增连续两次工具调用结果均回灌后再结束的回归测试，避免用单次工具调用代替 P02 多工具证据。

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
