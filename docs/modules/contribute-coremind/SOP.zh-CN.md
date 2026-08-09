# 源码与社区贡献开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先读 handoff 和权威方案。
2. 写失败测试再做最小实现。
3. 同步模块合同与双语文档。
4. 先跑聚焦测试，再执行 `npm run test:stability` 和 `npm run test:coverage`；覆盖率不得低于已记录基线。
5. 运行 `docs:audit`，检查全部项目 Markdown 的严格 UTF-8、本地链接与文档标识边界。
6. 运行 `acceptance:rc`，确认 P01～P19 逐 Case 绑定到实际测试；按 RC 指南完成双平台真实 TTY 与真实 Provider。
7. 由 Release Please 创建草稿发布 PR，使用 `release:sync-version` 同步 npm/Python 版本并更新双语发布说明。
8. 合并后只在同一干净 Tag 上执行 `release:bundle`，验证每个 npm tarball、wheel、源码 ZIP、SHA-256 和来源证明。
9. 展示 diff、双平台结果、Provider 结果与发布预检，确认受保护 OIDC 环境后再执行统一发布工作流。
10. 审核 Dependabot 对 Action 完整 SHA 与 npm/Python 依赖的更新；下载发布物后先校验 `SHA256SUMS.txt`，再进入证明、Registry 或 Release 步骤。
10. 保存 Trace、评测、产物清单和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
