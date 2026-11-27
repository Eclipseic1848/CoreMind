# Contributing to CoreMind

Thank you for helping CoreMind become safer and easier to learn. Code, tests, documentation, templates, provider evidence, and minimal bug reproductions are welcome. First-time open-source contributors are welcome too.

[简体中文](CONTRIBUTING.md) · [Code of Conduct](docs/en/community-code-of-conduct.md) · [Security](SECURITY.en.md) · [Documentation](docs/en/index.md)

## Agree on scope first

- Search [existing issues](https://github.com/Eclipseic1848/CoreMind/issues) before choosing a bug report or feature request from the [issue forms](https://github.com/Eclipseic1848/CoreMind/issues/new/choose).
- For bugs, include the CoreMind and component versions, operating system, Node.js or Python version, entry point, shortest reproduction, and expected and actual results. Include the commit SHA for source or candidate builds. Redact configuration and logs before sharing.
- For new features, open a feature request describing the user problem, scope, acceptance criteria, and non-goals.
- Never disclose a vulnerability in a public issue. Follow the security policy.
- Wait for maintainer agreement before implementing a major architectural change.

## Development setup

Engineering CI runs on Windows and Linux. Linux sandbox tests use `bubblewrap`, `socat`, and `ripgrep`. CoreMind requires Node.js 22.19 or later. To match CI, use the 22.x line and npm 11.5.1, the version pinned in `packageManager`. The Python SDK and ontology component require Python 3.10+. The knowledge and Hindsight memory components require Python 3.12+. Use a dedicated Python environment for the component under test.

```bash
git clone https://github.com/Eclipseic1848/CoreMind.git
cd CoreMind
npm ci
npm run build
npm run check
npm run test:engineering -- --maxWorkers=1
```

## Repository layout

The [npm workspaces](packages/) contain the TypeScript SDK (`coremind`), CLI/TUI, configuration, runtime, tools, templates, protocol, and bundled Worker. The [Python SDK](python/) uses that Worker. [Independent MCP services](components/) implement knowledge, memory, and ontology. [Module contracts and SOPs](docs/modules/) and [Skills](skills/) accompany the code. Keep dependencies one-way and use other packages' public interfaces.

## Workflow

1. Create a focused branch from the latest main branch.
2. Add a failing regression test or an executable acceptance test.
3. Implement the smallest change that satisfies it.
4. Update bilingual documentation, SOPs, Skills, examples, and changelogs when behavior changes.
5. When a phase gate completes, review the README, Code of Conduct, contributing guide, MIT License, security policy, and GitHub About. Update only facts, processes, or contact details that changed, and record reviewed items that need no edit.
6. Run the regression first, then the checks below that cover the change.
7. Review the diff for debug output, temporary files, secrets, and workstation paths.
8. Open a pull request and complete every relevant template field.

## Checks before opening a pull request

Engineering CI runs on pull requests and pushes to `main`. The setup commands above cover the build, static checks, and core deterministic tests. Use `npm test` for the full Node test suite. Record the checks you ran, results, and reasons for skipped checks in the pull request. [Engineering CI steps](.github/workflows/ci.yml) · [Pull request template](.github/PULL_REQUEST_TEMPLATE.md)

For documentation, run `npm run check:docs`, `npm run docs:audit`, and `npm run docs:build`. For a service in `components/`, run its module tests, then install its wheel in a fresh environment outside the checkout and check single-component use, authorization and removal. These commands run the offline ontology mapping and validation tests from the repository root. [Knowledge SOP](docs/modules/manage-knowledge/SOP.en.md) · [Memory SOP](docs/modules/manage-memory/SOP.en.md) · [Ontology SOP](docs/modules/manage-ontology/SOP.en.md)

```bash
python -m pip install -r examples/modules/manage-ontology/requirements.txt
python -B -X utf8 -m unittest discover -s examples/modules/manage-ontology -p "test_ontology_*.py" -v
python -m pip wheel --no-deps --wheel-dir .scratch/component-wheels ./components/ontology
```

For Python SDK changes, run these checks in a dedicated environment.

```bash
npm run build:python-worker
python -m pip install build twine ./python
python -X utf8 -m unittest discover -s python/tests -v
python -X utf8 -m build --wheel python
python -X utf8 -m twine check python/dist/*
npm run release:check-wheel
```

`release:check-wheel` installs the wheel in a fresh virtual environment, verifies its version, and starts the bundled Worker.

Changes to facts, projections, replay, or observability must also prove that projections rebuild deterministically from canonical facts without becoming recovery authority, and that CLI, TUI, TypeScript, and Python entries preserve the shared contract. Telemetry changes must cover default `DISABLED` behavior with no exporter construction, credential reads, or network; durable consent binding; field allowlists and recursive redaction; and exporter failures that cannot change RunOutcome, fact sequence, RecoveryDecision, or EffectState.

## Release candidates

Maintainers prepare the version in a Release Please draft PR. They qualify the frozen main commit with three stability runs per platform on Windows and Linux, coverage, real-terminal checks, live-provider certification, and artifact checks. npm and PyPI use protected environments and OIDC trusted publishing. A regular contribution requires no publishing credentials. [Candidate workflow](.github/workflows/candidate-qualification.yml) · [P01–P20 acceptance guide](docs/release/RC-ACCEPTANCE.en.md) · [Release SOP](docs/release/README.en.md)

## Documentation and provider evidence

Core user material is maintained in Simplified Chinese and English, encoded as UTF-8. A new functional module includes a bilingual README, guide, SOP, Skill, test entry points, and changelog. Document verified behavior and platform limits; do not turn adapter discovery into a certification claim.

Provider certification requires all live checks and redacted evidence in the [certification SOP](docs/providers/CERTIFICATION.en.md).

## Pull requests

Keep each pull request focused. Explain the user problem, non-goals, verification evidence, configuration or protocol impact, security or permission changes, compatibility impact, and any migration work.

By contributing, you agree to the [Code of Conduct](docs/en/community-code-of-conduct.md) and license your contribution under the project's [MIT License](LICENSE).
