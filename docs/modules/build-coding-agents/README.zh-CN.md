# 编码智能体

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

把“复现缺陷 → 定位原因 → 最小修改 → 目标测试 → 回归测试 → 审查差异”固化为受控流程，让没有智能体开发经验的工程师也能构建可验证的编码智能体。

该模块不是第二套 Runtime。CLI、TypeScript SDK、Python SDK 和源码用法继续共享同一套 Harness、Loop、权限、预算、Trace、Checkpoint 与终态语义。

## 公共接口

- `ProcessRunner`：使用命令与参数数组执行子进程，支持超时、中止、输出上限和受控环境变量。
- `GitAdapter`：只读 `status`、`diff`、`log`，不接受任意 Git 子命令或写操作。
- `createUnifiedDiff`、`diffFiles`：生成带输入、输出和复杂度上限的统一差异。
- `runEvaluationSuite`：运行 schemaVersion 1 或 2 的评测场景。
- `OutcomeGrader`、`TrajectoryGrader`、`CommandGrader`、`FileGrader`、`DiffGrader`、`StateGrader`、`ResponseGrader`。

## 安全边界

- 默认优先使用路径感知的 `read`、`edit`、`write` 与只读 Git 工具。
- Windows 宿主 Shell 只有在 `mode: full`、`workspaceOnly: false`、`network: allow` 同时满足时才开放；这代表用户明确接受宿主进程边界，不代表获得系统级隔离。
- Linux 内置 Shell 在隔离层不可用时失败关闭，不回退到宿主 Shell。
- 评测在运行前记录脏工作区基线；默认要求用户已有未提交内容保持原样。
- Checkpoint、Diff、Trace 与恢复在 full 模式下仍然生效。
- 本模块不自动执行 `git commit`、`git push`、发布、删除或其他扩大范围的动作。

## 已验证证据

- TypeScript 与 Python 各有一个真实缺陷仓库，确定性离线评测均通过。
- 两种语言都要求先观察失败，再进行最小修改，并分别通过目标测试与完整回归测试。
- 真实模型矩阵每种语言执行 5 次；能力与安全门禁均达到 5/5。详细证据保存在 Batch 8 交付报告中，发布负责人仍需完成候选版人工复核。
- 属性测试覆盖路径越界、权限组合、终态稳定、中止与重复动作上限。

## 源码、测试与示例

- [ProcessRunner](../../../packages/coremind-tools/src/process-runner.ts)
- [只读 GitAdapter](../../../packages/coremind-tools/src/git-adapter.ts)
- [统一 Diff](../../../packages/coremind-tools/src/unified-diff.ts)
- [评测器](../../../packages/coremind-runtime/src/evaluation-graders.ts)
- [真实缺陷示例](../../../examples/coding-evals/README.zh-CN.md)
- [模块示例](../../../examples/modules/build-coding-agents/README.zh-CN.md)
- [Agent Skill](../../../skills/build-coding-agents/SKILL.md)
