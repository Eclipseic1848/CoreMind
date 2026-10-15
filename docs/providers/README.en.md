# Provider Support and Certification Matrix

> This table was generated from the 2026-08-26 static runtime catalog and human-maintained evidence ledger and corresponds to target version `1.1.0`. Do not edit the table manually.

CoreMind has **42** built-in chat providers and **43** configurable entries including compatibility aliases. Complete real-call evidence exists for **0** entries, while **43** are catalog-only. **Configurable does not mean certified; aliases are not independent providers.**

## Status definitions

- **Certified**: the same model passed real streaming, tool-call, structured-result, multi-turn, abort, error-mapping, long-context, and parent/child Agent product-chain checks with auditable evidence.
- **Configurable, unverified**: configuration and model catalog resolution work, but the current version lacks complete real-call evidence; older evidence is historical only.
- **Configurable, incomplete current certification**: earlier evidence is retained but does not cover every current required check.
- A maintainer-approved network exception is not counted as certification and cannot enter the success ledger; disclose its version boundary in [Known limitations](../release/KNOWN-LIMITATIONS.en.md).
- Custom OpenAI-compatible endpoints are deployment-specific and must be accepted by each project.

## Current matrix

| Provider ID | Default model | Certified version | Models | Status | Evidence |
|---|---|---|---:|---|---|
| `alibaba-model-studio` | `qwen-plus` | `0.3.2` | 1 | Configurable, 1.1.0 unverified (older evidence retained) | [Evidence](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/alibaba-model-studio-0.3.2-2026-08-26.json) |
| `amazon-bedrock` | `amazon.nova-2-lite-v1:0` | — | 193 | Configurable, unverified | — |
| `ant-ling` | `Ling-2.6-1T` | — | 3 | Configurable, unverified | — |
| `anthropic` | `claude-fable-5` | — | 17 | Configurable, unverified | — |
| `azure` | `gpt-4` | — | 45 | Configurable, unverified | — |
| `azure-openai-responses` (compatibility alias of `azure`) | `gpt-4` | — | 45 | Configurable, unverified | — |
| `baseten` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 22 | Configurable, unverified | — |
| `cerebras` | `gpt-oss-120b` | — | 2 | Configurable, unverified | — |
| `cloudflare-ai-gateway` | `claude-fable-5` | — | 57 | Configurable, unverified | — |
| `cloudflare-workers-ai` | `@cf/deepseek-ai/deepseek-v4-flash-0731` | — | 18 | Configurable, unverified | — |
| `deepseek` | `deepseek-flash` | — | 2 | Configurable, unverified | — |
| `fireworks` | `accounts/fireworks/models/deepseek-v4p1-flash` | — | 22 | Configurable, unverified | — |
| `github-copilot` | `claude-fable-5` | — | 35 | Configurable, unverified | — |
| `google` | `deep-research-max-preview-04-2026` | — | 22 | Configurable, unverified | — |
| `google-vertex` | `gemini-2.5-flash` | — | 13 | Configurable, unverified | — |
| `groq` | `llama-3.1-8b-instant` | — | 7 | Configurable, unverified | — |
| `huggingface` | `deepseek-ai/DeepSeek-R1` | — | 78 | Configurable, unverified | — |
| `kimi-coding` | `k3` | — | 4 | Configurable, unverified | — |
| `meta` | `muse-spark-1.1` | — | 6 | Configurable, unverified | — |
| `minimax` | `MiniMax-M2.7` | — | 3 | Configurable, unverified | — |
| `minimax-cn` | `MiniMax-M2.7` | — | 3 | Configurable, unverified | — |
| `mistral` | `codestral-2508` | — | 40 | Configurable, unverified | — |
| `moonshotai` | `kimi-k2.6` | — | 4 | Configurable, unverified | — |
| `moonshotai-cn` | `kimi-k2.6` | — | 4 | Configurable, unverified | — |
| `nvidia` | `deepseek-ai/deepseek-v4.1-flash` | — | 21 | Configurable, unverified | — |
| `openai` | `gpt-4` | — | 44 | Configurable, unverified | — |
| `openai-codex` | `gpt-5.3-codex-spark` | — | 9 | Configurable, unverified | — |
| `opencode` | `claude-fable-5` | — | 83 | Configurable, unverified | — |
| `opencode-go` | `claude-haiku-5-5` | — | 31 | Configurable, unverified | — |
| `openrouter` | `anthropic/claude-fable-5` | — | 393 | Configurable, unverified | — |
| `qwen-token-plan` | `deepseek-v3.2` | — | 20 | Configurable, unverified | — |
| `qwen-token-plan-cn` | `deepseek-v3.2` | — | 20 | Configurable, unverified | — |
| `qwen-token-plan-individual` | `deepseek-v4-flash-0731` | — | 9 | Configurable, unverified | — |
| `radius` | `balanced` | — | 29 | Configurable, unverified | — |
| `together` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 17 | Configurable, unverified | — |
| `vercel-ai-gateway` | `alibaba/qwen-3-14b` | — | 245 | Configurable, unverified | — |
| `xai` | `grok-4.3` | — | 4 | Configurable, unverified | — |
| `xiaomi` | `mimo-v2.5` | — | 6 | Configurable, unverified | — |
| `xiaomi-token-plan-ams` | `mimo-v2.5` | — | 4 | Configurable, unverified | — |
| `xiaomi-token-plan-cn` | `mimo-v2.5` | — | 4 | Configurable, unverified | — |
| `xiaomi-token-plan-sgp` | `mimo-v2.5` | — | 4 | Configurable, unverified | — |
| `zai` | `glm-4.7` | — | 7 | Configurable, unverified | — |
| `zai-coding-cn` | `glm-4.6v` | — | 4 | Configurable, unverified | — |

## Adding a certification

Follow the [Provider certification SOP](CERTIFICATION.en.md). Add records only to `certifications.json`, then run `npm run providers:matrix`. Never mark a provider as certified without real credentials, run logs, and error-path evidence.
