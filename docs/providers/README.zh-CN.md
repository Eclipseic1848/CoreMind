# Provider 支持与认证矩阵

> 模型来自当前源码锁定的目录。认证依据 2026-11-27 的证据台账，须与目标版本 `2.2.0` 和打包 Runtime 的 SHA-256 一致。本页由脚本生成。

CoreMind 当前有 **43** 个内置聊天 Provider，含兼容别名共 **44** 个可配置入口。其中 **0** 个入口具有匹配当前构建的完整真实调用证据，**44** 个入口待认证。

## 状态定义

- **已认证**：同一模型完成真实流式输出、工具调用、结构化结果、多轮会话、中止、错误映射、长上下文与父子 Agent 产品链检查，并保存可审计证据。
- **可配置，未认证**：配置和模型目录可解析，但当前版本尚无完整真实调用证据；旧版证据只用于追溯。
- **可配置，未完成当前认证**：保留旧版证据，但缺少当前强制检查中的一项或多项，不计入已认证。
- 维护者批准的网络例外不计入认证数量，也不得写入成功台账；版本边界必须在[已知限制](../release/KNOWN-LIMITATIONS.zh-CN.md)中公开。
- 自定义 OpenAI 兼容端点不进入静态认证表，必须由项目针对实际部署单独验收。

## 当前矩阵

| Provider ID | 默认模型 | 认证版本 | 模型数 | 状态 | 证据 |
|---|---|---|---:|---|---|
| `alibaba-model-studio` | `qwen-plus` | `0.3.2` | 1 | 可配置，当前构建未认证（保留已测制品证据） | [证据](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/alibaba-model-studio-0.3.2-2026-08-26.json) |
| `amazon-bedrock` | `amazon.nova-2-lite-v1:0` | — | 204 | 可配置，未认证 | — |
| `ant-ling` | `Ling-3.0-flash` | — | 5 | 可配置，未认证 | — |
| `anthropic` | `claude-fable-5` | — | 18 | 可配置，未认证 | — |
| `azure` | `chat-latest` | — | 42 | 可配置，未认证 | — |
| `azure-openai-responses`（`azure` 的兼容别名） | `chat-latest` | — | 42 | 可配置，未认证 | — |
| `baseten` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 18 | 可配置，未认证 | — |
| `cerebras` | `gpt-oss-120b` | — | 2 | 可配置，未认证 | — |
| `cloudflare-ai-gateway` | `claude-fable-5` | — | 56 | 可配置，未认证 | — |
| `cloudflare-workers-ai` | `@cf/daily-co/phonellm-mini-alpha-2` | — | 13 | 可配置，未认证 | — |
| `deepseek` | `deepseek-flash` | `2.2.0` | 2 | 可配置，当前构建未认证（保留已测制品证据） | [证据](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/deepseek-2.2.0-2026-11-27.json) |
| `fireworks` | `accounts/fireworks/models/deepseek-v4p1-flash` | — | 42 | 可配置，未认证 | — |
| `github-copilot` | `claude-fable-5` | — | 33 | 可配置，未认证 | — |
| `google` | `deep-research-max-preview-04-2026` | — | 24 | 可配置，未认证 | — |
| `google-vertex` | `gemini-2.5-flash` | — | 17 | 可配置，未认证 | — |
| `groq` | `openai/gpt-oss-120b` | — | 4 | 可配置，未认证 | — |
| `huggingface` | `CohereLabs/command-a-plus-05-2026-bf16` | — | 114 | 可配置，未认证 | — |
| `kimi-coding` | `k3` | — | 6 | 可配置，未认证 | — |
| `meta` | `muse-ember-1.0` | — | 7 | 可配置，未认证 | — |
| `minimax` | `MiniMax-M2.7` | — | 4 | 可配置，未认证 | — |
| `minimax-cn` | `MiniMax-M2.7` | — | 4 | 可配置，未认证 | — |
| `mistral` | `codestral-2508` | — | 23 | 可配置，未认证 | — |
| `moonshotai` | `kimi-k2.6` | — | 6 | 可配置，未认证 | — |
| `moonshotai-cn` | `kimi-k2.6` | — | 6 | 可配置，未认证 | — |
| `nvidia` | `google/gemma-3-12b-it` | — | 11 | 可配置，未认证 | — |
| `openai` | `chat-latest` | — | 41 | 可配置，未认证 | — |
| `openai-codex` | `gpt-5.6-luna` | — | 10 | 可配置，未认证 | — |
| `opencode` | `claude-fable-5` | — | 83 | 可配置，未认证 | — |
| `opencode-go` | `claude-haiku-5-5` | — | 31 | 可配置，未认证 | — |
| `openrouter` | `~anthropic/claude-fable-latest` | — | 415 | 可配置，未认证 | — |
| `qwen-token-plan` | `deepseek-v4-flash-0731` | — | 20 | 可配置，未认证 | — |
| `qwen-token-plan-cn` | `deepseek-v4-flash-0731` | — | 20 | 可配置，未认证 | — |
| `qwen-token-plan-individual` | `deepseek-v4-flash-0731` | — | 13 | 可配置，未认证 | — |
| `qwen-token-plan-individual-cn` | `deepseek-v4-flash-0731` | — | 13 | 可配置，未认证 | — |
| `radius` | `balanced` | — | 39 | 可配置，未认证 | — |
| `together` | `deepseek-ai/DeepSeek-V4.1-Flash` | — | 24 | 可配置，未认证 | — |
| `vercel-ai-gateway` | `alibaba/qwen-3-14b` | — | 305 | 可配置，未认证 | — |
| `xai` | `grok-4.3` | — | 4 | 可配置，未认证 | — |
| `xiaomi` | `mimo-v2.6-flash` | — | 3 | 可配置，未认证 | — |
| `xiaomi-token-plan-ams` | `mimo-v2.6-flash` | — | 2 | 可配置，未认证 | — |
| `xiaomi-token-plan-cn` | `mimo-v2.6-flash` | — | 2 | 可配置，未认证 | — |
| `xiaomi-token-plan-sgp` | `mimo-v2.6-flash` | — | 2 | 可配置，未认证 | — |
| `zai` | `glm-4.7` | — | 8 | 可配置，未认证 | — |
| `zai-coding-cn` | `glm-4.6v` | — | 5 | 可配置，未认证 | — |

## 如何新增认证

请严格按照 [Provider 认证 SOP](CERTIFICATION.zh-CN.md) 执行。认证记录只能写入 `certifications.json`，随后运行 `npm run providers:matrix` 生成本页。没有真实密钥、运行日志和错误场景证据时，不得把状态改为“已认证”。
