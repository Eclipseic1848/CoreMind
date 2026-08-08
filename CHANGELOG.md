# CoreMind 变更日志

本文件记录面向用户的重要变化。版本遵循语义化版本；Beta 版本允许在发布说明中明确标注的接口调整。

[English](CHANGELOG.en.md)

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
