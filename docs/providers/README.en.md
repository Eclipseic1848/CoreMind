# Provider Support and Certification Matrix

> Generated on 2026-08-21 from the static runtime catalog and the human-maintained evidence ledger. Do not edit the table manually.

CoreMind currently supports configuration for **40** built-in providers. Complete real-call evidence exists for **1**, while **39** are catalog-only. **Configurable does not mean certified.**

## Status definitions

- **Certified**: the same model passed real streaming, tool-call, structured-result, multi-turn, abort, error-mapping, and long-context checks with auditable evidence.
- **Configurable, unverified**: configuration and model catalog resolution work, but complete real-call evidence is not available.
- **Configurable, incomplete current certification**: earlier evidence is retained but does not cover every check in the current seven-check standard.
- Custom OpenAI-compatible endpoints are deployment-specific and must be accepted by each project.

## Current matrix

| Provider ID | Default model | Certified version | Models | Status | Evidence |
|---|---|---|---:|---|---|
| `alibaba-model-studio` | `qwen-plus` | `0.3.1` | 1 | Certified | [Evidence](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/alibaba-model-studio-0.3.1-2026-08-21.json) |
| `amazon-bedrock` | `amazon.nova-2-lite-v1:0` | — | 114 | Configurable, unverified | — |
| `ant-ling` | `Ling-2.6-1T` | — | 3 | Configurable, unverified | — |
| `anthropic` | `claude-fable-5` | — | 13 | Configurable, unverified | — |
| `azure-openai-responses` | `gpt-4` | — | 38 | Configurable, unverified | — |
| `baseten` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 16 | Configurable, unverified | — |
| `cerebras` | `gemma-4-31b` | — | 3 | Configurable, unverified | — |
| `cloudflare-ai-gateway` | `claude-3-5-haiku` | — | 43 | Configurable, unverified | — |
| `cloudflare-workers-ai` | `@cf/google/gemma-4-26b-a4b-it` | — | 13 | Configurable, unverified | — |
| `deepseek` | `deepseek-v4-flash` | — | 2 | Configurable, unverified | — |
| `fireworks` | `accounts/fireworks/models/deepseek-v4-flash` | — | 17 | Configurable, unverified | — |
| `github-copilot` | `claude-haiku-4.5` | — | 30 | Configurable, unverified | — |
| `google` | `deep-research-max-preview-04-2026` | — | 24 | Configurable, unverified | — |
| `google-vertex` | `gemini-2.5-flash` | — | 12 | Configurable, unverified | — |
| `groq` | `llama-3.1-8b-instant` | — | 6 | Configurable, unverified | — |
| `huggingface` | `MiniMaxAI/MiniMax-M2` | — | 58 | Configurable, unverified | — |
| `kimi-coding` | `k3` | — | 4 | Configurable, unverified | — |
| `minimax` | `MiniMax-M2.7` | — | 3 | Configurable, unverified | — |
| `minimax-cn` | `MiniMax-M2.7` | — | 3 | Configurable, unverified | — |
| `mistral` | `codestral-latest` | — | 31 | Configurable, unverified | — |
| `moonshotai` | `kimi-k2-0711-preview` | — | 10 | Configurable, unverified | — |
| `moonshotai-cn` | `kimi-k2-0711-preview` | — | 10 | Configurable, unverified | — |
| `nvidia` | `google/gemma-3-12b-it` | — | 30 | Configurable, unverified | — |
| `openai` | `gpt-4` | — | 38 | Configurable, unverified | — |
| `openai-codex` | `gpt-5.3-codex-spark` | — | 7 | Configurable, unverified | — |
| `opencode` | `claude-fable-5` | — | 59 | Configurable, unverified | — |
| `opencode-go` | `minimax-m3` | — | 18 | Configurable, unverified | — |
| `openrouter` | `ai21/jamba-large-1.7` | — | 335 | Configurable, unverified | — |
| `qwen-token-plan` | `MiniMax-M2.5` | — | 16 | Configurable, unverified | — |
| `qwen-token-plan-cn` | `MiniMax-M2.5` | — | 16 | Configurable, unverified | — |
| `qwen-token-plan-individual` | `deepseek-v4-flash-0731` | — | 7 | Configurable, unverified | — |
| `together` | `MiniMaxAI/MiniMax-M2.7` | — | 18 | Configurable, unverified | — |
| `vercel-ai-gateway` | `alibaba/qwen-3-14b` | — | 197 | Configurable, unverified | — |
| `xai` | `grok-4.3` | — | 3 | Configurable, unverified | — |
| `xiaomi` | `mimo-v2-flash` | — | 6 | Configurable, unverified | — |
| `xiaomi-token-plan-ams` | `mimo-v2-pro` | — | 3 | Configurable, unverified | — |
| `xiaomi-token-plan-cn` | `mimo-v2-pro` | — | 3 | Configurable, unverified | — |
| `xiaomi-token-plan-sgp` | `mimo-v2-pro` | — | 3 | Configurable, unverified | — |
| `zai` | `glm-4.7` | — | 4 | Configurable, unverified | — |
| `zai-coding-cn` | `glm-4.7` | — | 4 | Configurable, unverified | — |

## Adding a certification

Follow the [Provider certification SOP](CERTIFICATION.en.md). Add records only to `certifications.json`, then run `npm run providers:matrix`. Never mark a provider as certified without real credentials, run logs, and error-path evidence.
