# Provider 与模型上手指南

## 什么时候使用

继承锁定运行时依赖的 Provider 清单，并把“可选”与“经过真实认证”严格分开。

## 最小示例

```text
provider:
  id: alibaba-model-studio
  model: qwen-plus
  apiKeyEnv: DASHSCOPE_API_KEY
```

这是 `0.8.0` 发布候选实际认证的 Provider/模型组合；在自己的密钥和部署环境中仍需复验。认证证据与静态矩阵的区别见[模块说明](README.zh-CN.md)。

## 为自定义 Qwen 服务选择思考开关

先核对部署的聊天模板接受哪个字段。读取顶层 `enable_thinking` 的服务使用 `provider.thinkingFormat: qwen`；读取 `chat_template_kwargs.enable_thinking` 的 vLLM 服务使用 `qwen-chat-template`。以下配置让一个摘要任务关闭思考，并将单次输出上限设为 900 token。将地址、模型名和凭据变量换成宿主实际提供的值。

```yaml
schemaVersion: 3
name: document-summary
provider:
  id: local-qwen
  baseUrl: http://127.0.0.1:8000/v1
  model: qwen-document
  apiKeyEnv: QWEN_API_KEY
  thinkingFormat: qwen-chat-template
agents:
  main:
    options: { thinkingLevel: off, maxTokens: 900 }
```

在该格式中，`off` 生成 `chat_template_kwargs.enable_thinking: false`；例如改为 `high` 后值为 `true`。运行库同时发送 `preserve_thinking: true`。所选格式决定请求字段的位置，输出预算仍由 `maxTokens` 控制。自定义服务默认省略这两种 Qwen 开关。

升级后，仅在需要嵌套开关的服务配置中启用新格式。回滚旧 SDK/Worker 前，先恢复该服务原先可用的配置；旧版本无法解析 `qwen-chat-template`。

## 在不启用工具的会话中继续使用工具历史

自定义 OpenAI 兼容端点恢复含工具调用的历史会话时，如果本轮没有可用工具，默认省略请求中的 `tools` 字段。旧版 LiteLLM 等网关在转发这类历史时可能要求保留该字段。对此类端点设置 `provider.requiresToolsWithToolHistory: true`，请求将包含 `tools: []`。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/manage-providers/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. `doctor` 检查本地配置。要取得 2.0.0 认证，请完成七项基础检查，以及父子调用链和取消收敛的五项检查。执行步骤见[供应商认证 SOP](../../providers/CERTIFICATION.zh-CN.md)。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要沿用缺少 abort 或长上下文检查的旧证据；矩阵会如实显示认证缺口。

上例的 Qwen 认证记录属于 `0.8.0`。`2.0.0` 已通过严格认证的模型与对应提交见[供应商矩阵](../../providers/README.zh-CN.md)。
