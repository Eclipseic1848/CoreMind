# Workflows and Explicit Bounded Loops Development SOP

## Prerequisites

Confirm the business owner, success criteria, verification rule, allowed repair scope, permission mode, budgets, and irreversible effects. Stop at design when any of these remain unresolved.

## Procedure

1. Map input, candidate, verification, repair, and terminal results. Prefer a Workflow for fixed dependencies.
2. Put deterministic decisions in normal code, a tool, or `passIf`; do not let the model invent acceptance rules at runtime.
3. Configure `maxIterations`, `maxRepairs`, `maxRepeatedAction`, `onFailure`, and `onExhausted` for every `loop`.
4. Declare every tool effect, reversibility, and target field. External effects also need a business idempotency key, receipt, or compensation process.
5. Write failure tests first. Verification failure, no progress, exhaustion, budget limits, denied approval, timeout, abort, and transient errors each need an explicit terminal result.
6. Verify that every stable transition persists and that resuming the same run ID does not replay completed steps or committed effects.
7. Compare the same state sequence and terminal result across CLI/TUI, TypeScript SDK, and Python SDK.
8. Run module tests, the golden example, coverage, and `npm run check:modules`; preserve traces and human conclusions.

## Required commands

```powershell
npx vitest run packages/coremind-runtime/src/loop-controller.test.ts packages/coremind-runtime/src/loop-runner.test.ts packages/coremind-runtime/src/retry-policy.test.ts
npx vitest run examples/golden/golden-examples.test.ts
npm run test:coverage
npm run check:modules
```

## Stop conditions

Stop for unknown effects, unclear business verification, a configuration-fingerprint mismatch, unavailable real credentials, failed security gates, or access outside the workspace. Do not hide a defect by raising retry counts, changing permission modes, or substituting a provider. Never commit, push, tag, or publish without explicit authorization.
