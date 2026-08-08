# Contributing to CoreMind

Thank you for helping CoreMind become safer and easier to learn. Code, tests, documentation, templates, provider evidence, and minimal bug reproductions are welcome. First-time open-source contributors are welcome too.

[简体中文](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.en.md) · [Security](SECURITY.en.md) · [Documentation](docs/en/index.md)

## Agree on scope first

- Search existing issues before reporting a bug; include a minimal reproduction, expected behavior, and actual behavior.
- Open a feature request before large changes and state the user problem, scope, acceptance criteria, and non-goals.
- Never disclose a vulnerability in a public issue. Follow the security policy.
- Wait for maintainer agreement before implementing a major architectural change.

## Development setup

Use Windows or Linux, Node.js 22.19+, npm 10+, and Python 3.10+ for Python SDK work.

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
5. Run focused tests and then the full quality gate.
6. Review the diff for debug output, temporary files, secrets, and workstation paths.
7. Open a pull request and complete every relevant template field.

```bash
npm run build
npm run check
npm test
npm run docs:build
npm run release:preflight -- --allow-dirty
```

Python changes also require the Python test suite, worker build, wheel build, and a clean-environment installation check.

## Documentation and provider evidence

Core user material is maintained in Simplified Chinese and English, encoded as UTF-8. A new functional module includes a bilingual README, guide, SOP, Skill, test entry points, and changelog. Document verified behavior and platform limits; do not turn adapter discovery into a certification claim.

Provider certification requires all live checks and redacted evidence in the [certification SOP](docs/providers/CERTIFICATION.en.md).

## Pull requests

Keep each pull request focused. Explain the user problem, non-goals, verification evidence, configuration or protocol impact, security or permission changes, compatibility impact, and any migration work.

By contributing, you agree to the [Code of Conduct](CODE_OF_CONDUCT.en.md) and license your contribution under the project's MIT License.
