# CoreMind Changelog / 变更日志

本文件记录面向用户的重要变化。版本遵循语义化版本；Beta 版本允许在发布说明中明确标注的接口调整。

This file records user-facing changes. Versions follow Semantic Versioning; beta releases may include explicitly documented interface changes.

## 0.2.0-beta.1 — 2026-08-08

### 新增 / Added

- Config v2、Protocol v1，以及一致的 TypeScript/Python SDK 运行语义。
- 有预算、权限、Trace、RunState、Checkpoint、恢复和质量门禁的受控执行循环。
- CLI/TUI 的 `create`、`run`、`chat`、`check`、`eval`、`doctor` 和模板入口。
- 16 个功能模块与 4 个黄金示例，每个模块包含双语 README、GUIDE、SOP、Skill 和测试入口。
- 双语文档站、社区治理文件、Issue/PR 模板和 npm/PyPI 发布预检。
- 38 个可配置 Provider 入口及证据驱动认证矩阵；阿里云模型服务 `qwen-plus` 完成五项真实认证。
- Linux 内置 Shell 的操作系统级隔离、断网和工作区写入限制；隔离不可用时失败关闭。

- Config v2 and Protocol v1 with aligned TypeScript and Python runtime semantics.
- A bounded execution loop with budgets, permissions, traces, run state, checkpoints, recovery, and quality gates.
- CLI/TUI commands for project creation, execution, chat, checks, evaluation, diagnostics, and templates.
- Sixteen capability modules and four golden examples with bilingual learning and operating material.
- A bilingual documentation site, community governance, issue/PR templates, and npm/PyPI preflight checks.
- Thirty-eight configurable provider entries and an evidence-based certification matrix; Alibaba Cloud Model Studio `qwen-plus` passed all five live checks.
- OS-level Linux shell isolation with networking denied, workspace-only writes, and fail-closed behavior.

### 安全与兼容性 / Security and compatibility

- 生产依赖审计为 0 个已知漏洞。
- 文档工具的已知开发服务器风险通过移除服务器命令、仅静态构建和带到期日的风险策略隔离。
- Windows 一期没有与 Linux 对等的操作系统级 Shell 隔离；macOS 尚未正式支持。

- Production dependencies have zero known audit findings.
- Known documentation dev-server risks are isolated by removing server commands, allowing static builds only, and enforcing an expiring risk policy.
- Phase one does not provide Linux-equivalent shell isolation on Windows; macOS is not yet officially supported.

### 升级说明 / Upgrade notes

这是从 `0.1.0-alpha.2` 到新公共合同的 Beta 升级。请重新生成项目配置并运行 `coremind check`；不要假设旧 Alpha 配置、结果字段或恢复状态可以直接复用。

This is a beta upgrade from `0.1.0-alpha.2` to the new public contracts. Regenerate project configuration and run `coremind check`; do not assume Alpha configuration, result fields, or recovery state can be reused unchanged.
