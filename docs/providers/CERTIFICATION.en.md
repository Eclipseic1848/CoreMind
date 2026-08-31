# Provider Certification SOP

Provider discovery means that CoreMind has an adapter entry point. It does not mean the provider has been certified. A provider becomes certified only after every live check below passes and reviewable evidence is recorded. See the current [provider matrix](./README.en.md).

## Prerequisites

1. Use an official account, production API endpoint, and a verifiable model identifier.
2. Obtain explicit approval before sending test input to an external service.
3. Inject API keys through environment variables only. Never place secrets in configuration, logs, screenshots, or commits.
4. Record the CoreMind version, OS, Node.js version, provider, model, and test time.
5. Do not use personal data, confidential material, or production data.
6. Before execution, explicitly approve the provider, model, credential source, cost cap, maximum duration, candidate commit, and Runtime candidate-package SHA-256.

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

## Revocation

Evidence must include provider, model, CoreMind version, candidate commit, Runtime and candidate-package digests, date, platform, every check, synthetic long-context size, parent/child result, cancellation convergence, zero-retry redacted usage, and a reviewable link. Downgrade certification when a current check is missing, an API changes incompatibly, a default model is retired, a live regression fails, a security issue is found, or no retest occurred across a major version. Repeat the complete procedure before restoring certification.
