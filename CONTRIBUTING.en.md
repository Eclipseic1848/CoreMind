# Contributing to CoreMind

Thank you for helping CoreMind become safer and easier to learn. Code, tests, documentation, templates, provider evidence, and minimal bug reproductions are welcome. First-time open-source contributors are welcome too.

[简体中文](CONTRIBUTING.md) · [Code of Conduct](docs/en/community-code-of-conduct.md) · [Security](SECURITY.en.md) · [Documentation](docs/en/index.md)

## Agree on scope first

- Search existing issues before reporting a bug; include a minimal reproduction, expected behavior, and actual behavior.
- Open a feature request before large changes and state the user problem, scope, acceptance criteria, and non-goals.
- Never disclose a vulnerability in a public issue. Follow the security policy.
- Wait for maintainer agreement before implementing a major architectural change.

## Development setup

Use Windows or Linux, Node.js 22.19+, npm 11.5.1+, and Python 3.10+ for Python SDK work.

```bash
git clone https://github.com/Eclipseic1848/CoreMind.git
cd CoreMind
npm ci
npm run build
npm test
npm run check
```

## Workflow

1. Create a focused branch from the latest main branch.
2. Add a failing regression test or an executable acceptance test.
3. Implement the smallest change that satisfies it.
4. Update bilingual documentation, SOPs, Skills, examples, and changelogs when behavior changes.
5. When a phase gate completes, review the README, Code of Conduct, contributing guide, MIT License, security policy, and GitHub About. Update only facts, processes, or contact details that changed, and record reviewed items that need no edit.
6. Run focused tests and then the full quality gate.
7. Review the diff for debug output, temporary files, secrets, and workstation paths.
8. Open a pull request and complete every relevant template field.

```bash
npm run build
npm run check
npm run test:stability
npm run test:coverage
npm run docs:build
npm run release:check-npm
npm run release:test-npm
npm run release:test-source
npm run acceptance:rc
npm run docs:audit
npm run release:preflight -- --allow-dirty
```

Python changes also require the Python test suite, Worker build, wheel build, Twine, and `npm run release:check-wheel`, which installs into a fresh virtual environment and starts the bundled Worker. A candidate still needs three consecutive Windows/Linux runs plus separately recorded real-pseudoterminal evidence from both target platforms.

Changes to facts, projections, replay, or observability must also prove that projections rebuild deterministically from canonical facts without becoming recovery authority, and that CLI, TUI, TypeScript, and Python entries preserve the shared contract. Telemetry changes must cover default `DISABLED` behavior with no exporter construction, credential reads, or network; durable consent binding; field allowlists and recursive redaction; and exporter failures that cannot change RunOutcome, fact sequence, RecoveryDecision, or EffectState.

Release versions are prepared through a Release Please draft PR, never by tagging a feature branch directly. Follow the [RC acceptance guide](docs/release/RC-ACCEPTANCE.en.md) for P01-P20, both target platforms, the current live-provider recheck, and same-commit evidence; run the repository-wide Markdown audit again before archiving the candidate. npm and PyPI use protected GitHub environments and OIDC trusted publishing, so contributors must not submit registry tokens. See the [release SOP](docs/release/README.en.md) for the complete process.

## Documentation and provider evidence

Core user material is maintained in Simplified Chinese and English, encoded as UTF-8. A new functional module includes a bilingual README, guide, SOP, Skill, test entry points, and changelog. Document verified behavior and platform limits; do not turn adapter discovery into a certification claim.

Provider certification requires all live checks and redacted evidence in the [certification SOP](docs/providers/CERTIFICATION.en.md).

## Pull requests

Keep each pull request focused. Explain the user problem, non-goals, verification evidence, configuration or protocol impact, security or permission changes, compatibility impact, and any migration work.

By contributing, you agree to the [Code of Conduct](docs/en/community-code-of-conduct.md) and license your contribution under the project's MIT License.
