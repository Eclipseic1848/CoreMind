# CoreMind Release SOP

This procedure releases source, GitHub Release, npm packages, the PyPI package, and the documentation site at one stability level. Success on one channel never substitutes for complete acceptance.

## Principles

- A maintainer must explicitly authorize publication. Passing preflight is not publishing permission.
- TypeScript and Python ship together and keep the same runtime semantics.
- All npm workspaces use one version and exact internal dependency versions.
- Production dependency findings and documentation-tool findings are reported separately, never hidden.
- Release evidence comes from clean environments on real target platforms.

## Candidate gate

Freeze scope and version, resolve security and compatibility decisions, synchronize npm and Python versions, update changelogs and provider evidence, and begin from an intentional Git diff.

```bash
npm ci
npm run build
npm run check
npm test
npm run docs:build
npm run release:preflight
npm audit --omit=dev
npm audit
```

Complete clean Windows and Linux installation, manual TUI, TypeScript SDK, Python SDK, recovery, security-boundary, and live certified-provider acceptance. macOS is documented as unsupported for phase one.

## Artifact gate

```bash
npm publish --dry-run --workspaces --if-present --json
npm run build:python-worker
python -X utf8 -m build python
python -X utf8 -m twine check python/dist/*
python -X utf8 scripts/check-python-wheel.py python/dist/*.whl
```

Install the wheel in a fresh virtual environment and test imports, synchronous and asynchronous clients, the real worker, and golden examples. Inspect npm tarballs and the wheel for secrets, environment files, workstation paths, caches, or unexpected source.

## Authorization and order

Present a candidate report with version, commit, platform evidence, test totals, live-provider evidence, audits, known limits, artifact checks, and rollback plan. Continue only after explicit approval.

Publish npm packages in dependency order, verify a fresh registry install, publish and verify PyPI, create the protected tag and GitHub Release, then deploy the matching bilingual documentation. Do not promote a stable distribution tag before artifact verification.

If any channel fails, stop. Published artifacts are not overwritten: deprecate or withdraw the affected version and issue a corrected version. Record all evidence in the handoff. Phase one remains open without Windows/Linux acceptance, live-provider evidence, and cleared security gates.
