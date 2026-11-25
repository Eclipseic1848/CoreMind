# Provider 与模型示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
provider:
  id: alibaba-model-studio
  model: qwen-plus
  apiKeyEnv: DASHSCOPE_API_KEY
```

这是 `0.8.0` 发布候选完成真实认证的 Provider/模型组合；部署到其他凭据或环境仍需复验，证据范围见[Provider 模块](../../../docs/modules/manage-providers/README.zh-CN.md)。

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 只验证本例配置时无需外发。要取得 2.0.0 认证，先取得外发与费用授权，再用同一版本、Provider 和模型完成七项基础检查，以及父子调用链和取消收敛的五项检查。见[供应商认证 SOP](../../../docs/providers/CERTIFICATION.zh-CN.md)。

返回 [中文指南](../../../docs/modules/manage-providers/GUIDE.zh-CN.md)。
