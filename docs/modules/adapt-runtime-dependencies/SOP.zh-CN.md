# Runtime 依赖升级与回滚 SOP

## 前置条件

先阅读[模块说明](README.zh-CN.md)，固定参考版本、候选版本、受影响 seam、迁移范围和回滚点。真实 Provider 请求、费用或代码外发必须另行授权。

## 执行步骤

1. 运行 `npm run build`、`npm run baseline:check` 和 `npm run dependencies:check` 保存改动前证据。
2. 为版本唯一性和受影响行为写失败测试。
3. 把核心依赖全部改为同一精确版本，使用 `npm install --ignore-scripts` 更新 Lockfile。
4. 在私有 Adapter 内转换消息、工具、Usage 和错误；不得向 Config 增加底层版本字段。
5. 运行 Provider streaming/tool/abort/usage/error/timeout、Session roundtrip 和工具合同测试。
6. 构建公开类型聚合文件，确认 Runtime 与统一 SDK 根入口只暴露 CoreMind 自有消息、工具和结果合同。
7. 重新生成 Provider 矩阵与依赖报告；新增条目保持“可配置、未认证”。
8. 写清 Session/API 迁移和整体回滚命令，再以明确原因更新候选基线。
9. 执行 Windows/Linux 安装、构建、打包、CLI 与 Python Worker smoke。
10. 同步 README、Guide、SOP、Skill、示例和 Changelog；运行文档门禁。

## 回滚

把三个核心包整体恢复为同一旧版本，恢复 Lockfile 与会话 Adapter，重新构建并运行参考 Case。不能只回退其中一个包。

## 停止条件

出现无法解释的消息丢失、工具参数变化、usage 错账、Session 无损恢复失败或安全门禁失败时立即停止，不得用类型强转继续。
