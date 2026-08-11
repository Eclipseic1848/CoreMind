# 编码智能体开发 SOP

## 前置条件

明确任务范围、允许修改的文件、禁止修改的文件、测试命令、完成标准、权限模式和审批负责人。若这些信息无法从工程发现，先询问，不允许模型自行扩展范围。

## 执行步骤

1. 记录当前分支、`git status --short`、既有脏文件和受保护文件指纹。
2. 执行 `inspectCodingRepository`，把语言、包管理器与测试命令显示为建议；有多个候选或没有测试命令时，由用户选择 TypeScript、JavaScript 或 Python，并明确命令。
3. 用 `buildRepositoryMap` 建立有界仓库地图，用 `createEngineeringTaskPlan` 固定验收条件和六阶段计划。
4. 用最小目标测试复现缺陷；无法复现时停止修改并报告证据缺口。
5. 读取与失败直接相关的实现和测试，写出一个可验证的根因假设。
6. 每次 `edit` 或 `write` 前创建 checkpoint；只修改完成任务所需的最少文件和最少代码，不得覆盖用户既有改动。
7. 先运行目标测试，再运行完整回归测试；把真实命令、退出码、耗时和 Artifact 写入验证证据。失败不得用文字解释替代。
8. 验证失败时只按失败证据进入有界 repair；达到重复动作、无进展、修复次数或预算上限后停止。
9. 使用 `git_status` 与 `git_diff` 核对修改范围，并由 `EngineeringEvidenceLedger` 检查变更、checkpoint、测试和最终声明一致性。
10. 用 schemaVersion 2 的 outcome、trajectory、command、file、diff、state、response grader 验证结果。
11. TypeScript 与 Python 均至少执行单文件、跨文件、错误命令、审批拒绝、中止恢复、Diff/Restore 和脏工作区保护用例。
12. 保存模型、Provider、版本、平台、运行次数、成功率、工具数、耗时、token、成本、审批、失败分类、安全事件和人工复核结论。
13. 只有 `ReleaseReadiness.ready`、安全门禁和负责人验收同时通过后，才可请求提交或发布授权。

## 停止条件

- 缺陷无法复现或测试口径不明确。
- 需要写工作区外路径、访问未授权网络或暴露真实密钥。
- 需要覆盖用户既有修改、修改禁止文件或扩大需求范围。
- 发生无法自动回退的副作用，但没有明确授权或外部收据。
- 安全发现、评测失败或目标/回归测试失败。

停止后保留工程现状与 Trace，向负责人说明已验证事实、未决事项和下一步选择。
