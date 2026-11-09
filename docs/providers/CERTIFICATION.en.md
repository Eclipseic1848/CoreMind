# Provider Certification SOP

Provider discovery means that CoreMind has an adapter entry point. It does not mean the provider has been certified. A provider becomes certified only after every live check below passes and reviewable evidence is recorded. See the current [provider matrix](./README.en.md).

## Prerequisites

1. Use an official account, production API endpoint, and a verifiable model identifier.
2. Obtain explicit approval before sending test input to an external service.
3. Inject API keys through environment variables only. Never place secrets in configuration, logs, screenshots, or commits.
4. Record the CoreMind version, OS, Node.js version, provider, model, and test time.
5. Do not use personal data, confidential material, or production data.
6. Before execution, explicitly approve the provider, model, credential source, cost cap, maximum duration, candidate commit, and Runtime candidate-package SHA-256.

### Billing prerequisite for Alibaba qwen-plus

The built-in `alibaba-model-studio` route uses the Beijing endpoint. The `trial` hostname does not establish free usage: the endpoint also serves [pay-as-you-go requests](https://help.aliyun.com/zh/model-studio/base-url). Zero rates in model metadata and usage accumulated after `turn_end` cannot establish the approved cost cap.

Alibaba certification currently accepts only `qwen-plus`. Before execution, the operator must verify in the console that this model has unexpired, unexhausted free quota and that the stop-on-free-quota-exhaustion control is already effective. Without this confirmation, do not execute. The control takes time to apply; ordinary budget-triggered immediate suspension can also incur charges during its delay and cannot replace this protection. See the [free-quota policy](https://help.aliyun.com/zh/model-studio/new-free-quota/) and [budget-management documentation](https://help.aliyun.com/zh/model-studio/budget-management).

Only after verification may the operator set Candidate Qualification input `alibaba_free_quota_only_confirmed` to `true`; it defaults to `false`. The local certification script uses `COREMIND_CERT_ALIBABA_FREE_QUOTA_ONLY_CONFIRMED=true`. This records an operator declaration, not an automated account check. Evidence records the fixed `billingControl` value `operator-confirmed-alibaba-beijing-qwen-plus-free-quota-only`. Single-run approval, the cost cap, zero retries, candidate identity and all timeouts still apply; the confirmation does not establish live certification.

Alibaba certification injects the key from GitHub Actions Secret `COREMIND_CERT_API_KEY`; never put its value in workflow inputs or evidence. Built-in Beijing `qwen-plus` requests use `max_tokens`. Named Agents reselect the output-limit field when switching models; other custom endpoints retain their behavior. Request compatibility does not establish billing protection or live-service acceptance. See the [official API documentation](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) for parameter semantics.

### CNY certification budget for DeepSeek

This route is fixed to `deepseek` / `deepseek-flash`, with credentials injected from GitHub Actions Secret `DEEPSEEK_API_KEY` and account settlement in CNY. Candidate Qualification input `max_cost_cny` (local environment variable `COREMIND_CERT_MAX_COST_CNY`) must contain the explicitly approved CNY amount for this run. Approval records retain `maxCostCny`, `billingCurrency: "CNY"` and `billingControl: "deepseek-flash-cny-reserved-v1"`. The existing `max_cost_usd` and SDK cost-estimate gate remain independent, without currency conversion or offsets between budgets. Alibaba retains the prerequisites above.

Certification fixes `maxTokens: 1024` and `thinkingLevel: "off"`. Reservations use [official peak CNY prices](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/): CNY 2 per million uncached input tokens and CNY 8 per million output tokens. Before dispatch, every request reserves **CNY 2.105344** for the full 1,048,576-token input window plus 1,024 output tokens. Character estimates, expected cache hits and usage observed so far do not replace this request bound.

One reservation ledger covers the entire certification, including parent, child Agent, failed and cancelled requests. Only complete, trustworthy usage, a finish reason and `[DONE]` allow the unused reservation to be released; otherwise the full reservation remains. Insufficient available budget rejects a request before dispatch. This local rejection does not pass authentication testing: the invalid-key check still sends one real request and requires a real HTTP 401. Zero retries, original acceptance criteria and all timeouts remain unchanged.

After offline implementation and engineering CI pass on both platforms, obtain new single-run live approval bound to the candidate commit and Runtime-package SHA-256, including the CNY amount and data-egress boundaries. Previous approval, a stored key or budget rejection cannot replace this approval or establish certification or release.

## Required checks

| Check | Pass condition |
| --- | --- |
| Streaming | Incremental content arrives correctly and the final text and finish reason are complete |
| Tool call | Arguments are valid, the tool result is returned, and generation continues |
| Structured result | Output matches the declared structure; invalid output is rejected or repaired |
| Multi-turn | Context stays correct for at least three turns without role contamination |
| Abort | An active generation can be explicitly stopped, reports `aborted`, and leaves the Runtime usable |
| Error handling | Invalid keys, rate limits, timeouts, and server errors remain diagnosable without leaking secrets |
| Long context | At the recorded synthetic input size, the model still returns the boundary marker without real user or business data |
| Parent/child Agent chain | The parent model calls `delegate`, the Child uses the same approved Provider and a controlled tool, the structured result returns to the parent, and cancelling an active Child reaches zero active descendants within the approved bound |

## Procedure

1. Start with one provider, one model, and one controlled synthetic tool. A mutating tool may write only inside the run's temporary workspace.
2. Run every check and retain only redacted approval bounds, configuration summaries, result summaries, and usage. Do not retain credential values, raw traces, or synthetic response bodies.
3. Stop on any failure, exceeded bound, or unknown Effect. Do not retry automatically or create a success record.
4. Update `docs/providers/certifications.json` only after every check passes.
5. Run `npm run build && npm run providers:matrix` to regenerate both matrices.
6. Run `npm run check` and `npm test` to verify that documentation and runtime discovery remain aligned.
7. Ask another maintainer to review the evidence, data-egress approval, and redaction before merge.

## Failure diagnostics

Before temporary-workspace cleanup, a failed certification attempts to write one fixed-field `COREMIND_CERTIFICATION_FAILURE` log record and a separate `.scratch/provider-certification-failure.json` file (at most 4 KiB). Strict candidate qualification uploads it separately as `provider-certification-failure-<commit>`, without changing the success ledger. The summary contains only candidate identity, stage, parent/child counts, booleans, enums, approval counts, and observed usage. It excludes response bodies, tool arguments, paths, credentials, and arbitrary exceptions. Parent/child certification requires successful tool receipts; error receipts cannot count as completion.

Synthetic certification prompts provide explicit JSON arguments for `delegate` and `write`; approval still matches the target, task, and written content exactly. Approval rejection in the successful-child scenario records only a fixed classification: target, task, path, or content mismatch; unexpected agent/tool; or unclassified rejection. Unknown classifications become `unknown`. Classification uses the actual rejected request, does not infer arguments from other calls in the same batch, and never grants approval.

Failed-run usage is `partial` or `unknown`, with missing values recorded as `null`. It is not zero cost, a complete bill, or remaining authorization for another call. Output failures preserve the original certification failure and cleanup; forced process termination may prevent recording. Diagnostics confer no certification and further live validation requires explicit approval.

## Revocation

Evidence must include provider, model, CoreMind version, candidate commit, Runtime and candidate-package digests, date, platform, every check, synthetic long-context size, parent/child result, cancellation convergence, zero-retry redacted usage, and a reviewable link. Downgrade certification when a current check is missing, an API changes incompatibly, a default model is retired, a live regression fails, a security issue is found, or no retest occurred across a major version. Repeat the complete procedure before restoring certification.
