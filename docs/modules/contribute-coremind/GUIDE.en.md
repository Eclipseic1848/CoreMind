# Source and Community Contribution Guide

## When to use it

Change CoreMind source within its one-way dependencies, test-first workflow, bilingual material contract, and release authorization boundary.

## Minimal example

```text
npm run build
npm run check
npm run test:stability
npm run test:coverage
npm run docs:build
npm run docs:audit
npm run acceptance:rc
npm run release:preflight -- --allow-dirty
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/contribute-coremind/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. A formal candidate needs three consecutive runs on both Windows and Linux. Keep missing platform evidence pending instead of substituting another platform.
6. Follow the [RC acceptance guide](../../release/RC-ACCEPTANCE.en.md) for both real TTY files and live-provider evidence. Artifacts must come from one clean tag.
7. Release Please only prepares a draft PR. The unified workflow publishes npm, PyPI, attestations, and the GitHub Release only after protected OIDC environment approval.
8. External Actions accept verified full SHAs only. Dependabot upgrade PRs rerun the same gates, and every artifact consumer independently verifies SHA-256.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not claim target coverage is already met. The current gate preserves the measured baseline, blocks decreases, and reports the remaining 80%/90% gaps.
- Do not treat a Release Please PR, historical provider evidence, or one platform's TTY as a completed release.
