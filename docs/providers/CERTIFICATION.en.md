# Provider Certification SOP

Provider discovery means that CoreMind has an adapter entry point. It does not mean the provider has been certified. A provider becomes certified only after every live check below passes and reviewable evidence is recorded. See the current [provider matrix](./README.en.md).

## Prerequisites

1. Use an official account, production API endpoint, and a verifiable model identifier.
2. Obtain explicit approval before sending test input to an external service.
3. Inject API keys through environment variables only. Never place secrets in configuration, logs, screenshots, or commits.
4. Record the CoreMind version, OS, Node.js version, provider, model, and test time.
5. Do not use personal data, confidential material, or production data.

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

## Procedure

1. Start with one provider, one model, and one side-effect-free tool.
2. Run all seven checks and retain redacted commands, configuration summaries, and result summaries.
3. Re-run failed checks once; a single intermittent success is not sufficient.
4. Add one evidence record to `docs/providers/certifications.json`. Every one of the seven checks must be `true`.
5. Run `npm run build && npm run providers:matrix` to regenerate both matrices.
6. Run `npm run check` and `npm test` to verify that documentation and runtime discovery remain aligned.
7. Ask another maintainer to review the evidence, data-egress approval, and redaction before merge.

## Revocation

Evidence must include provider, model, CoreMind version, date, platform, all seven results, the synthetic long-context size, and a reviewable link. Downgrade certification when a current check is missing, an API changes incompatibly, a default model is retired, a live regression fails, a security issue is found, or no retest occurred across a major version. Repeat the complete procedure before restoring certification.
