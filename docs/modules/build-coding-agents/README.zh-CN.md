# 编码智能体

状态：`0.3.0-rc.2` 发布候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

把“复现缺陷 → 定位原因 → 最小修改 → 目标测试 → 回归测试 → 审查差异”固化为受控流程，让没有智能体开发经验的工程师也能构建可验证的编码智能体。

该能力现已成为 Runtime 内的第一方 Engineering Kernel，而不只是示例组合，也不是第二套 Runtime。CLI、TypeScript SDK、Python SDK 和源码用法继续共享同一套 Harness、Loop、权限、预算、Session、Context、Trace、Checkpoint、Eval 与终态语义。

## 公共接口

- `inspectCodingRepository`：有界、只读地探测 TypeScript、JavaScript、Python、包管理器和测试命令；探测结果只作为建议。
- `selectCodingEnvironment`：在语言、包管理器或测试命令存在歧义时要求用户明确选择。
- `buildRepositoryMap`、`createEngineeringTaskPlan`：形成仓库地图和“理解 → 计划 → 修改 → 验证 → 修复 → 交付”六阶段任务计划。
- `createEngineeringKernelDefinition`：生成复用通用 `LoopController` 的有界 verify/repair 定义，并默认启用 Runtime 证据门。
- `engineering_evidence` 事件：Runtime 从真实工具执行、命令退出码、Checkpoint 与 `git_diff` 自动判定交付证据；模型输出 `PASS` 只是必要条件，不能单独决定成功。
- `EngineeringEvidenceLedger`：仅保留为旧版外部证据导入兼容层；新代码不得手工填写它来形成成功结论。
- `ProcessRunner`：使用命令与参数数组执行子进程，支持超时、中止、输出上限和受控环境变量。
- `GitAdapter`：只读 `status`、`diff`、`log`，不接受任意 Git 子命令或写操作。
- `createUnifiedDiff`、`diffFiles`：生成带输入、输出和复杂度上限的统一差异。
- `runEvaluationSuite`：运行 schemaVersion 1 或 2 的评测场景。
- `OutcomeGrader`、`TrajectoryGrader`、`CommandGrader`、`FileGrader`、`DiffGrader`、`StateGrader`、`ResponseGrader`。

## 安全边界

- 默认优先使用路径感知的 `read`、`edit`、`write` 与只读 Git 工具。
- `edit` 与 `write` 的每个变更都必须关联写入前 checkpoint；进程与网络继续经过通用权限策略，不由 Coding Kernel 绕过。
- 自动探测不会替用户决定工程入口；混合语言、多个锁文件或未知测试命令会形成明确待选择项。
- Windows 宿主 Shell 只有在 `mode: full`、`workspaceOnly: false`、`network: allow` 同时满足时才开放；这代表用户明确接受宿主进程边界，不代表获得系统级隔离。
- Linux 内置 Shell 在隔离层不可用时失败关闭，不回退到宿主 Shell。
- 评测在运行前记录脏工作区基线；默认要求用户已有未提交内容保持原样。
- Checkpoint、Diff、Trace 与恢复在 full 模式下仍然生效。
- Runtime Trace 只保存命令 SHA-256、是否为测试命令、退出码和耗时，不持久化命令原文或凭据。
- 本模块不自动执行 `git commit`、`git push`、发布、删除或其他扩大范围的动作。

## 已验证证据

- TypeScript 与 Python 各有一个真实单文件缺陷仓库，确定性离线评测均通过。
- 两种语言都新增跨文件缺陷、错误命令、审批拒绝、中止、Diff 与 Restore 用例；未运行或失败的测试不能被记录为通过。
- 两种语言都要求先观察失败，再进行最小修改，并分别通过目标测试与完整回归测试。
- 真实模型矩阵每种语言执行 5 次；能力与安全门禁均达到 5/5。公开仓库保留可复现评测场景，原始运行记录随候选验收证据归档。
- 属性测试覆盖路径越界、权限组合、终态稳定、中止与重复动作上限。

## 源码、测试与示例

- [ProcessRunner](../../../packages/coremind-tools/src/process-runner.ts)
- [只读 GitAdapter](../../../packages/coremind-tools/src/git-adapter.ts)
- [统一 Diff](../../../packages/coremind-tools/src/unified-diff.ts)
- [评测器](../../../packages/coremind-runtime/src/evaluation-graders.ts)
- [Engineering Kernel](../../../packages/coremind-runtime/src/coding/engineering-kernel.ts)
- [Kernel 合同测试](../../../packages/coremind-runtime/src/coding/engineering-kernel.test.ts)
- [Runtime 证据门](../../../packages/coremind-runtime/src/coding/runtime-engineering-evidence.ts)
- [真实缺陷示例](../../../examples/coding-evals/README.zh-CN.md)
- [模块示例](../../../examples/modules/build-coding-agents/README.zh-CN.md)
- [Agent Skill](../../../skills/build-coding-agents/SKILL.md)
