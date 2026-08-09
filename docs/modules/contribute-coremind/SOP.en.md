# Source and Community Contribution Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Read the handoff and authoritative plan first.
2. Write a failing test before the smallest implementation.
3. Synchronize module contracts and bilingual docs.
4. Run focused tests, then `npm run test:stability` and `npm run test:coverage`; coverage may not fall below the recorded baseline.
5. Run `docs:audit` across all project Markdown for strict UTF-8, local links, and the documentation identifier boundary.
6. Run `acceptance:rc`, require P01-P19 to bind to real tests, and complete both real TTY files plus a live provider under the RC guide.
7. Let Release Please open a draft release PR, use `release:sync-version` for npm/Python parity, and update both release notes.
8. After merge, run `release:bundle` only on one clean tag and validate every npm tarball, wheel, source ZIP, SHA-256, and attestation.
9. Present the diff, platform results, provider result, and preflight, then approve protected OIDC environments before the unified release workflow.
10. Review Dependabot updates to pinned Action SHAs and npm/Python dependencies. After downloading the bundle, verify `SHA256SUMS.txt` before attestation, registry, or Release work.
10. Preserve traces, evaluations, artifact manifests, and owner approval; do not publish implicitly.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
