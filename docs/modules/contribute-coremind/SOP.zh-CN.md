# 源码与社区贡献开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先读 handoff 和权威方案。
2. 运行 `npm run build` 和 `npm run baseline:check`，确认改动前的 Release 身份、公开合同、依赖组合、行为矩阵和质量下限成立。
3. 写失败测试再做最小实现。
4. 如果有意改变公开合同，先写迁移与回滚说明；获得架构决定后，才可用 `npm run baseline:update -- --reason "原因"` 更新基线。
5. 同步模块合同与双语文档。
6. 先跑聚焦测试，再执行 `npm run test:stability` 和 `npm run test:coverage`；Windows/Linux 覆盖率不得低于各自已记录基线，通用回退不得低于两平台的逐项最小值。
7. 运行 `docs:audit`，检查全部项目 Markdown 的严格 UTF-8、本地链接与文档标识边界。
8. 运行 `acceptance:rc`，确认 P01～P19 逐 Case 绑定到实际测试；按 RC 指南完成双平台真实伪终端与真实 Provider。
9. 同题编码对照必须固定模型、参数、初始提交、预算、超时和网络条件；真实外部运行前先获得费用、隐私与代码外发授权，未运行时保持 `not-run`。
10. 由 Release Please 创建草稿发布 PR，使用 `release:sync-version` 同步 npm/Python 版本并更新双语发布说明。
11. 合并后只在同一干净 Tag 上执行 `release:bundle`，验证每个 npm tarball、wheel、源码 ZIP、SHA-256 和来源证明。
12. 展示 diff、双平台结果、Provider 结果与发布预检，确认受保护 OIDC 环境后再执行统一发布工作流。
13. 审核 Dependabot 对 Action 完整 SHA 与 npm/Python 依赖的更新；确认锁定的发布工具未被官方 Registry 撤回。工具版本变化后重跑工作流合同和发布物门禁。
14. 下载发布物后先校验 `SHA256SUMS.txt`，再进入证明、Registry 或 Release 步骤。
15. 保存 Trace、评测、产物清单和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
