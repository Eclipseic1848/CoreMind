# Provider 支持与认证矩阵

> 生成日期：2026-08-08。本页由运行时静态目录和人工证据台账生成，不应手工改表格。

CoreMind 当前可配置 **38** 个内置 Provider，其中 **1** 个具有完整真实调用证据，**37** 个仅代表运行时目录可识别。**可配置不等于通过真实认证。**

## 状态定义

- **已认证**：同一模型完成真实流式输出、工具调用、结构化结果、多轮会话和错误处理，并保存可审计证据。
- **可配置，未认证**：配置和模型目录可解析，但尚无完整真实调用证据。
- 自定义 OpenAI 兼容端点不进入静态认证表，必须由项目针对实际部署单独验收。

## 当前矩阵

| Provider ID | 默认模型 | 模型数 | 状态 | 证据 |
|---|---|---:|---|---|
| `alibaba-model-studio` | `qwen-plus` | 1 | 已认证 | [证据](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/alibaba-model-studio-2026-08-08.json) |
| `amazon-bedrock` | `amazon.nova-2-lite-v1:0` | 114 | 可配置，未认证 | — |
| `ant-ling` | `Ling-2.6-1T` | 3 | 可配置，未认证 | — |
| `anthropic` | `claude-fable-5` | 15 | 可配置，未认证 | — |
| `azure-openai-responses` | `gpt-4` | 38 | 可配置，未认证 | — |
| `cerebras` | `gemma-4-31b` | 3 | 可配置，未认证 | — |
| `cloudflare-ai-gateway` | `claude-3-5-haiku` | 43 | 可配置，未认证 | — |
| `cloudflare-workers-ai` | `@cf/google/gemma-4-26b-a4b-it` | 13 | 可配置，未认证 | — |
| `deepseek` | `deepseek-v4-flash` | 2 | 可配置，未认证 | — |
| `fireworks` | `accounts/fireworks/models/deepseek-v4-flash` | 16 | 可配置，未认证 | — |
| `github-copilot` | `claude-haiku-4.5` | 29 | 可配置，未认证 | — |
| `google` | `deep-research-max-preview-04-2026` | 24 | 可配置，未认证 | — |
| `google-vertex` | `gemini-2.5-flash` | 12 | 可配置，未认证 | — |
| `groq` | `llama-3.1-8b-instant` | 7 | 可配置，未认证 | — |
| `huggingface` | `MiniMaxAI/MiniMax-M2` | 51 | 可配置，未认证 | — |
| `kimi-coding` | `k3` | 4 | 可配置，未认证 | — |
| `minimax` | `MiniMax-M2.7` | 3 | 可配置，未认证 | — |
| `minimax-cn` | `MiniMax-M2.7` | 3 | 可配置，未认证 | — |
| `mistral` | `codestral-latest` | 30 | 可配置，未认证 | — |
| `moonshotai` | `kimi-k2-0711-preview` | 10 | 可配置，未认证 | — |
| `moonshotai-cn` | `kimi-k2-0711-preview` | 10 | 可配置，未认证 | — |
| `nvidia` | `google/gemma-3-12b-it` | 30 | 可配置，未认证 | — |
| `openai` | `gpt-4` | 38 | 可配置，未认证 | — |
| `openai-codex` | `gpt-5.3-codex-spark` | 7 | 可配置，未认证 | — |
| `opencode` | `claude-fable-5` | 59 | 可配置，未认证 | — |
| `opencode-go` | `minimax-m3` | 16 | 可配置，未认证 | — |
| `openrouter` | `ai21/jamba-large-1.7` | 303 | 可配置，未认证 | — |
| `qwen-token-plan` | `MiniMax-M2.5` | 15 | 可配置，未认证 | — |
| `qwen-token-plan-cn` | `MiniMax-M2.5` | 15 | 可配置，未认证 | — |
| `together` | `MiniMaxAI/MiniMax-M2.7` | 17 | 可配置，未认证 | — |
| `vercel-ai-gateway` | `alibaba/qwen-3-14b` | 193 | 可配置，未认证 | — |
| `xai` | `grok-4.3` | 3 | 可配置，未认证 | — |
| `xiaomi` | `mimo-v2-flash` | 6 | 可配置，未认证 | — |
| `xiaomi-token-plan-ams` | `mimo-v2-pro` | 3 | 可配置，未认证 | — |
| `xiaomi-token-plan-cn` | `mimo-v2-pro` | 3 | 可配置，未认证 | — |
| `xiaomi-token-plan-sgp` | `mimo-v2-pro` | 3 | 可配置，未认证 | — |
| `zai` | `glm-4.5-air` | 6 | 可配置，未认证 | — |
| `zai-coding-cn` | `glm-4.5-air` | 6 | 可配置，未认证 | — |

## 如何新增认证

请严格按照 [Provider 认证 SOP](CERTIFICATION.zh-CN.md) 执行。认证记录只能写入 `certifications.json`，随后运行 `npm run providers:matrix` 生成本页。没有真实密钥、运行日志和错误场景证据时，不得把状态改为“已认证”。
