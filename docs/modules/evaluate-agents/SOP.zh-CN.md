# 测试、评测与质量门禁开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先定义业务成功条件。
2. 为正常、边界、失败、拒绝、超时和中止建立场景。
3. 文本兼容场景可使用 schemaVersion 1；需要工具、文件、差异和状态证据时使用 schemaVersion 2。
4. schemaVersion 2 至少配置 outcome grader，再按风险增加 trajectory、command、file、diff、state 和 response grader。
5. 在运行前保存脏工作区与受保护文件基线，明确允许和禁止修改的路径。
6. 运行 `coremind check` 与 `coremind eval`；strict 场景至少重复三次。
7. 将确定性离线结果与真实模型结果分开记录；真实结果同时记录模型、Provider、平台、次数、费用/Token 和数据外发授权。
8. 只根据 ReleaseReadiness、安全门禁、最终测试和负责人复核决定是否进入发布。
9. 需要比较策略时，先固定实验 id、版本、seed、arm 权重和输入指纹生成规则；每个 arm 使用同一任务、预算、Provider 和 grader。
10. 用 `runExperiment` 保存环境、选择哈希、真实 RunOutcome、指标、完整 Trace 和 grader；不要只保存模型文字。
11. 运行模块列出的测试，并执行 `npm run check:modules`。
12. 保存 Trace、grader、差异和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
