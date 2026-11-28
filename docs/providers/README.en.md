# Provider Support and Certification Matrix

> Models come from the catalog pinned by this source tree. Certification records in the 2026-11-27 ledger must match target version `2.2.0` and the SHA-256 of the bundled runtime. This page is generated.

CoreMind has **43** built-in chat providers and **44** configurable entries including compatibility aliases. **0** entries have complete real-call evidence for the current build. **44** entries await certification.

## Status definitions

- **Certified**: the same model passed real streaming, tool-call, structured-result, multi-turn, abort, error-mapping, long-context, and parent/child Agent product-chain checks with auditable evidence.
- **Configurable, unverified**: configuration and model catalog resolution work, but the current version lacks complete real-call evidence; older evidence is historical only.
- **Configurable, incomplete current certification**: earlier evidence is retained but does not cover every current required check.
- A maintainer-approved network exception is not counted as certification and cannot enter the success ledger; disclose its version boundary in [Known limitations](../release/KNOWN-LIMITATIONS.en.md).
- Custom OpenAI-compatible endpoints are deployment-specific and must be accepted by each project.

## Current matrix

| Provider ID | Default model | Certified version | Models | Status | Evidence |
|---|---|---|---:|---|---|
| `alibaba-model-studio` | `qwen-plus` | `0.3.2` | 1 | Configurable, current build unverified (tested artifact evidence retained) | [Evidence](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/alibaba-model-studio-0.3.2-2026-08-26.json) |
| `amazon-bedrock` | `amazon.nova-2-lite-v1:0` | — | 204 | Configurable, unverified | — |
| `ant-ling` | `Ling-3.0-flash` | — | 5 | Configurable, unverified | — |
| `anthropic` | `claude-fable-5` | — | 18 | Configurable, unverified | — |
| `azure` | `chat-latest` | — | 42 | Configurable, unverified | — |
| `azure-openai-responses` (compatibility alias of `azure`) | `chat-latest` | — | 42 | Configurable, unverified | — |
| `baseten` | `deepseek-ai/DeepSeek-V4-Flash-0731` | — | 18 | Configurable, unverified | — |
| `cerebras` | `gpt-oss-120b` | — | 2 | Configurable, unverified | — |
| `cloudflare-ai-gateway` | `claude-fable-5` | — | 56 | Configurable, unverified | — |
| `cloudflare-workers-ai` | `@cf/daily-co/phonellm-mini-alpha-2` | — | 13 | Configurable, unverified | — |
| `deepseek` | `deepseek-flash` | `2.2.0` | 2 | Configurable, current build unverified (tested artifact evidence retained) | [Evidence](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/deepseek-2.2.0-2026-11-27.json) |
| `fireworks` | `accounts/fireworks/models/deepseek-v4p1-flash` | — | 42 | Configurable, unverified | — |
| `github-copilot` | `claude-fable-5` | — | 33 | Configurable, unverified | — |
| `google` | `deep-research-max-preview-04-2026` | — | 24 | Configurable, unverified | — |
| `google-vertex` | `gemini-2.5-flash` | — | 17 | Configurable, unverified | — |
| `groq` | `openai/gpt-oss-120b` | — | 4 | Configurable, unverified | — |
| `huggingface` | `CohereLabs/command-a-plus-05-2026-bf16` | — | 114 | Configurable, unverified | — |
| `kimi-coding` | `k3` | — | 6 | Configurable, unverified | — |
| `meta` | `muse-ember-1.0` | — | 7 | Configurable, unverified | — |
| `minimax` | `MiniMax-M2.7` | — | 4 | Configurable, unverified | — |
| `minimax-cn` | `MiniMax-M2.7` | — | 4 | Configurable, unverified | — |
| `mistral` | `codestral-2508` | — | 23 | Configurable, unverified | — |
| `moonshotai` | `kimi-k2.6` | — | 6 | Configurable, unverified | — |
| `moonshotai-cn` | `kimi-k2.6` | — | 6 | Configurable, unverified | — |
| `nvidia` | `google/gemma-3-12b-it` | — | 11 | Configurable, unverified | — |
| `openai` | `chat-latest` | — | 41 | Configurable, unverified | — |
| `openai-codex` | `gpt-5.6-luna` | — | 10 | Configurable, unverified | — |
| `opencode` | `claude-fable-5` | — | 83 | Configurable, unverified | — |
| `opencode-go` | `claude-haiku-5-5` | — | 31 | Configurable, unverified | — |
| `openrouter` | `~anthropic/claude-fable-latest` | — | 415 | Configurable, unverified | — |
| `qwen-token-plan` | `deepseek-v4-flash-0731` | — | 20 | Configurable, unverified | — |
| `qwen-token-plan-cn` | `deepseek-v4-flash-0731` | — | 20 | Configurable, unverified | — |
| `qwen-token-plan-individual` | `deepseek-v4-flash-0731` | — | 13 | Configurable, unverified | — |
| `qwen-token-plan-individual-cn` | `deepseek-v4-flash-0731` | — | 13 | Configurable, unverified | — |
| `radius` | `balanced` | — | 39 | Configurable, unverified | — |
| `together` | `deepseek-ai/DeepSeek-V4.1-Flash` | — | 24 | Configurable, unverified | — |
| `vercel-ai-gateway` | `alibaba/qwen-3-14b` | — | 305 | Configurable, unverified | — |
| `xai` | `grok-4.3` | — | 4 | Configurable, unverified | — |
| `xiaomi` | `mimo-v2.6-flash` | — | 3 | Configurable, unverified | — |
| `xiaomi-token-plan-ams` | `mimo-v2.6-flash` | — | 2 | Configurable, unverified | — |
| `xiaomi-token-plan-cn` | `mimo-v2.6-flash` | — | 2 | Configurable, unverified | — |
| `xiaomi-token-plan-sgp` | `mimo-v2.6-flash` | — | 2 | Configurable, unverified | — |
| `zai` | `glm-4.7` | — | 8 | Configurable, unverified | — |
| `zai-coding-cn` | `glm-4.6v` | — | 5 | Configurable, unverified | — |

## Adding a certification

Follow the [Provider certification SOP](CERTIFICATION.en.md). Add records only to `certifications.json`, then run `npm run providers:matrix`. Never mark a provider as certified without real credentials, run logs, and error-path evidence.
