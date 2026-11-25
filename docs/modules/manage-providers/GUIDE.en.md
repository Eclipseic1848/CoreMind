# Providers and Models Guide

## When to use it

Inherit the provider catalog from the locked runtime dependency while keeping availability separate from real certification.

## Minimal example

```text
provider:
  id: alibaba-model-studio
  model: qwen-plus
  apiKeyEnv: DASHSCOPE_API_KEY
```

This is the provider/model pair certified in the `0.8.0` release candidate; reverify it with your credentials and deployment environment. See the [module overview](README.en.md) for the difference between Candidate evidence and the static matrix.

## Select the thinking switch for a custom Qwen endpoint

Check which field your deployed chat template reads. Choose `provider.thinkingFormat: qwen` for a top-level `enable_thinking` field. Choose `qwen-chat-template` for vLLM endpoints that read `chat_template_kwargs.enable_thinking`. This example disables thinking for a summary task with a 900-token output limit. Replace the endpoint, model ID and credential variable with your deployment's values.

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

In this format, `off` sends `chat_template_kwargs.enable_thinking: false`. Set `high`, for example, to send `true`. The runtime also sends `preserve_thinking: true`. The selected format controls the location of the switch and `maxTokens` still controls the output budget. Custom endpoints omit both Qwen switches by default.

After upgrading, enable the new format only for endpoints that read the nested switch. Before rolling back the SDK and Worker, restore the endpoint's previous working configuration. Older versions cannot parse `qwen-chat-template`.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/manage-providers/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. `doctor` checks local configuration. For 2.0.0 certification, run the seven base checks and the five checks covering the parent/child call chain and cancellation convergence. Follow the [provider certification SOP](../../providers/CERTIFICATION.en.md).

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not reuse older evidence that lacks abort or long-context checks. The matrix reports those gaps explicitly.

The Qwen certification cited above applies to `0.8.0`. The [provider matrix](../../providers/README.en.md) identifies the model and commit certified for `2.0.0`.
