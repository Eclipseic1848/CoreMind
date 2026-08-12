# Source and Community Contribution Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Read the handoff and authoritative plan first.
2. Run `npm run build` and `npm run baseline:check` to prove the pre-change Release identity, public contracts, dependency combination, behavior matrix, and quality floors.
3. Write a failing test before the smallest implementation.
4. For an intentional public-contract change, document migration and rollback first. Update the baseline with `npm run baseline:update -- --reason "reason"` only after an architecture decision approves it.
5. Synchronize module contracts and bilingual docs.
6. Run focused tests, then `npm run test:stability` and `npm run test:coverage`. Windows/Linux coverage may not fall below their recorded floors, and the generic fallback may not be weaker than their per-metric minimum.
7. Run `docs:audit` across all project Markdown for strict UTF-8, local links, and the documentation identifier boundary.
8. Run `acceptance:rc`, require P01-P19 to bind to real tests, and complete both real-pseudoterminal files plus a live provider under the RC guide.
9. Same-task coding comparisons must keep the model, options, initial commit, budget, timeout, and network conditions fixed. Obtain cost, privacy, and code-egress authorization before a live external run; otherwise retain `not-run`.
10. Let Release Please open a draft release PR, use `release:sync-version` for npm/Python parity, and update both release notes.
11. After merge, run `release:bundle` only on one clean tag and validate every npm tarball, wheel, source ZIP, SHA-256, and attestation.
12. Present the diff, platform results, provider result, and preflight, then approve protected OIDC environments before the unified release workflow.
13. Review Dependabot updates to pinned Action SHAs and npm/Python dependencies, and confirm pinned release tools have not been yanked by their official registries. Rerun workflow contracts and artifact gates after a tool-version change.
14. After downloading the bundle, verify `SHA256SUMS.txt` before attestation, registry, or Release work.
15. Preserve traces, evaluations, artifact manifests, and owner approval; do not publish implicitly.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
