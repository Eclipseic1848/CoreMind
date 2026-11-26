# 测试、评测与质量门禁开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先定义业务成功条件。
2. 为正常、边界、失败、拒绝、超时和中止建立场景。
3. 文本兼容场景可使用 schemaVersion 1；需要工具、文件、差异和状态证据时使用 schemaVersion 2。
4. schemaVersion 2 至少配置 outcome grader，再按风险增加 trajectory、command、file、diff、state 和 response grader。
5. 在运行前保存脏工作区与受保护文件基线，明确允许和禁止修改的路径。验证 diff 的 `preserveExisting: false` 仍按基线与终态的状态或内容差异执行 `allowedPaths`、`forbiddenPaths`、`requiredPaths`、`maxChangedFiles`，状态和内容均未变化的既有脏文件不计、原 untracked 文件删除计入变化；默认 `true` 的保护保持不变。
6. 运行 `coremind check` 与 `coremind eval`；strict 场景至少重复三次。
7. 将确定性离线结果与真实模型结果分开记录；真实结果同时记录模型、Provider、平台、次数、费用/Token 和数据外发授权。
8. 只根据 ReleaseReadiness、安全门禁、最终测试和负责人复核决定是否进入发布。
9. 需要比较策略时，先固定实验 id、版本、seed、arm 权重和输入指纹生成规则；每个 arm 使用同一任务、预算、Provider 和 grader。
10. 用 `runExperiment` 保存环境、选择哈希、真实 RunOutcome、指标、完整 Trace 和 grader；不要只保存模型文字。
11. 运行模块列出的测试，并执行 `npm run check:modules`。
12. 保存 Trace、grader、差异和人工确认记录；未经明确授权不发布。

## 五项可选能力效果回归

按[最小示例](../../../examples/modules/evaluate-agents/README.zh-CN.md#五项可选能力离线回归)运行并保存 JSON。先固定题目、来源、预期结果、预算及验收条件，再运行两组或复跑同一组。替换合成题时保留一组未参与调试的题，记录题集与夹具版本。

| 能力 | 判分证据 |
| --- | --- |
| 知识 | 分别统计正例 Top1/Top5、答案文本、来源版本与位置、正确拒答和错误作答。无答案题仍可召回相似内容。 |
| Hindsight 记忆 | 记录候选错误准入、已确认经验误用和漏用，核对当前版本、作用域和确认状态。 |
| Skill | 对同一任务运行启用和禁用两组，统计正确处理、错误或多余触发，以及两组用量。离线用量来自夹具，真实成本使用获准实测的用量和对应价格。 |
| 工具 | 对照本地、stdio 和 HTTP 实际调用记录。核对调用次数、授权、原始参数及结构化结果。 |
| 本体 | 核对同一请求标识、目标、原状态和结果。检查重复请求返回同一回执，缺失业务回执时报告 `unknown` 并阻止后续写入。 |

汇总报告中的 `passed` 由各子评测退出状态决定。检查失败域的错误及已有证据，修复后用同一题集和夹具复跑。用独立授权的验证评估真实模型和业务环境。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
