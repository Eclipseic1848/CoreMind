# Provider 支持与认证矩阵

> 表格基于 2026-08-26 的运行时静态目录和人工证据台账生成，当前对应目标版本 `1.0.1`。不应手工修改表格。

CoreMind 当前有 **42** 个内置聊天 Provider，含兼容别名共 **43** 个可配置入口。其中 **0** 个入口具有完整真实调用证据，**43** 个仅代表运行时目录可识别。**可配置不等于通过真实认证，别名不重复计为独立提供商。**

## 状态定义

- **已认证**：同一模型完成真实流式输出、工具调用、结构化结果、多轮会话、中止、错误映射、长上下文与父子 Agent 产品链检查，并保存可审计证据。
- **可配置，未认证**：配置和模型目录可解析，但当前版本尚无完整真实调用证据；旧版证据只用于追溯。
- **可配置，未完成当前认证**：保留旧版证据，但缺少当前强制检查中的一项或多项，不计入已认证。
- 维护者批准的网络例外不计入认证数量，也不得写入成功台账；版本边界必须在[已知限制](../release/KNOWN-LIMITATIONS.zh-CN.md)中公开。
- 自定义 OpenAI 兼容端点不进入静态认证表，必须由项目针对实际部署单独验收。

## 当前矩阵

| Provider ID | 默认模型 | 认证版本 | 模型数 | 状态 | 证据 |
|---|---|---|---:|---|---|
| `alibaba-model-studio` | `qwen-plus` | `0.3.2` | 1 | 可配置，1.0.1 未认证（保留旧版证据） | [证据](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/alibaba-model-studio-0.3.2-2026-08-26.json) |
| `amazon-bedrock` | `amazon.nova-2-lite-v1:0` | — | 193 | 可配置，未认证 | — |
| `ant-ling` | `Ling-2.6-1T` | — | 3 | 可配置，未认证 | — |
| `anthropic` | `claude-fable-5` | — | 17 | 可配置，未认证 | — |
| `azure` | `gpt-4` | — | 45 | 可配置，未认证 | — |
| `azure-openai-responses`（`azure` 的兼容别名） | `gpt-4` | — | 45 | 可配置，未认证 | — |
| `baseten` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 22 | 可配置，未认证 | — |
| `cerebras` | `gpt-oss-120b` | — | 2 | 可配置，未认证 | — |
| `cloudflare-ai-gateway` | `claude-fable-5` | — | 57 | 可配置，未认证 | — |
| `cloudflare-workers-ai` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | — | 18 | 可配置，未认证 | — |
| `deepseek` | `deepseek-flash` | — | 2 | 可配置，未认证 | — |
| `fireworks` | `accounts/fireworks/models/deepseek-v4p1-flash` | — | 22 | 可配置，未认证 | — |
| `github-copilot` | `claude-fable-5` | — | 35 | 可配置，未认证 | — |
| `google` | `deep-research-max-preview-04-2026` | — | 22 | 可配置，未认证 | — |
| `google-vertex` | `gemini-2.5-flash` | — | 13 | 可配置，未认证 | — |
| `groq` | `llama-3.1-8b-instant` | — | 7 | 可配置，未认证 | — |
| `huggingface` | `deepseek-ai/DeepSeek-R1` | — | 78 | 可配置，未认证 | — |
| `kimi-coding` | `k3` | — | 4 | 可配置，未认证 | — |
| `meta` | `muse-spark-1.1` | — | 6 | 可配置，未认证 | — |
| `minimax` | `MiniMax-M2.7` | — | 3 | 可配置，未认证 | — |
| `minimax-cn` | `MiniMax-M2.7` | — | 3 | 可配置，未认证 | — |
| `mistral` | `codestral-2508` | — | 40 | 可配置，未认证 | — |
| `moonshotai` | `kimi-k2.6` | — | 4 | 可配置，未认证 | — |
| `moonshotai-cn` | `kimi-k2.6` | — | 4 | 可配置，未认证 | — |
| `nvidia` | `deepseek-ai/deepseek-v4.1-flash` | — | 21 | 可配置，未认证 | — |
| `openai` | `gpt-4` | — | 44 | 可配置，未认证 | — |
| `openai-codex` | `gpt-5.3-codex-spark` | — | 9 | 可配置，未认证 | — |
| `opencode` | `claude-fable-5` | — | 83 | 可配置，未认证 | — |
| `opencode-go` | `claude-haiku-5-5` | — | 31 | 可配置，未认证 | — |
| `openrouter` | `anthropic/claude-fable-5` | — | 393 | 可配置，未认证 | — |
| `qwen-token-plan` | `deepseek-v3.2` | — | 20 | 可配置，未认证 | — |
| `qwen-token-plan-cn` | `deepseek-v3.2` | — | 20 | 可配置，未认证 | — |
| `qwen-token-plan-individual` | `deepseek-v4-flash-0731` | — | 9 | 可配置，未认证 | — |
| `radius` | `balanced` | — | 29 | 可配置，未认证 | — |
| `together` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 17 | 可配置，未认证 | — |
| `vercel-ai-gateway` | `alibaba/qwen-3-14b` | — | 245 | 可配置，未认证 | — |
| `xai` | `grok-4.3` | — | 4 | 可配置，未认证 | — |
| `xiaomi` | `mimo-v2.5` | — | 6 | 可配置，未认证 | — |
| `xiaomi-token-plan-ams` | `mimo-v2.5` | — | 4 | 可配置，未认证 | — |
| `xiaomi-token-plan-cn` | `mimo-v2.5` | — | 4 | 可配置，未认证 | — |
| `xiaomi-token-plan-sgp` | `mimo-v2.5` | — | 4 | 可配置，未认证 | — |
| `zai` | `glm-4.7` | — | 7 | 可配置，未认证 | — |
| `zai-coding-cn` | `glm-4.6v` | — | 4 | 可配置，未认证 | — |

## 如何新增认证

请严格按照 [Provider 认证 SOP](CERTIFICATION.zh-CN.md) 执行。认证记录只能写入 `certifications.json`，随后运行 `npm run providers:matrix` 生成本页。没有真实密钥、运行日志和错误场景证据时，不得把状态改为“已认证”。
