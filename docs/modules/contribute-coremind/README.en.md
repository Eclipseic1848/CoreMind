# Source and Community Contribution

Status: release-candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Change CoreMind source within its one-way dependencies, test-first workflow, bilingual material contract, and release authorization boundary, with repeatable proof that same-commit source, npm packages, the Python wheel, the independent source ZIP, and the documentation site agree.

## Public interfaces

- `npm run build`
- `npm test`
- `npm run check`
- `npm run check:modules`
- `npm run docs:build`
- `npm run docs:audit`
- `npm run test:stability`
- `npm run test:coverage`
- `npm run release:check-npm`
- `npm run release:test-npm`
- `npm run release:test-source`
- `npm run release:check-wheel`
- `npm run providers:matrix`
- `npm run release:preflight`
- `npm run release:sync-version -- <semver>`
- `npm run acceptance:rc`
- `npm run release:bundle -- --tag <tag>`

## Errors and boundaries

- Dependencies must remain config to tools to templates to runtime to facade/CLI/worker
- Never push, tag, or publish without authorization
- Preserve unrelated user changes
- `.scratch` is reserved for ignored local acceptance evidence and isolated tool environments; it is excluded from Git, static checks, and artifacts.
- Provider discovery is not certification; releases require live evidence
- One passing test run does not replace three consecutive Windows/Linux runs. Record honest per-platform coverage floors below target, allow them only to increase, and set the generic fallback to their per-metric minimum.
- Release artifacts must pass file allowlists, type resolution, clean installation, and bundled Worker startup.
- Release Please creates a draft release PR only; maintainers still approve tags and publication.
- External Actions use full commit SHAs and Dependabot proposes reviewable upgrades.
- npm, Python build, and upload tools use explicit versions. If a registry yanks one, the RC must move to a verified non-yanked version and rerun artifact gates.
- npm/PyPI trusted-publishing identity binds the workflow filename and protected environment; any mismatch stops publication.
- Artifacts must come from one clean tag with SHA-256, a manifest, and build attestation.

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [package.json](../../../package.json)
- [vitest.config.ts](../../../vitest.config.ts)
- [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)
- [.github/workflows/docs.yml](../../../.github/workflows/docs.yml)
- [.github/workflows/release-please.yml](../../../.github/workflows/release-please.yml)
- [.github/workflows/publish-pypi.yml](../../../.github/workflows/publish-pypi.yml)
- [.github/dependabot.yml](../../../.github/dependabot.yml)
- [.release-please-manifest.json](../../../.release-please-manifest.json)
- [release-please-config.json](../../../release-please-config.json)
- [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [SECURITY.md](../../../SECURITY.md)
- [docs/.vitepress/config.mts](../../../docs/.vitepress/config.mts)
- [docs/providers/certifications.json](../../../docs/providers/certifications.json)
- [docs/release/README.zh-CN.md](../../../docs/release/README.zh-CN.md)
- [docs/release/RC-ACCEPTANCE.en.md](../../../docs/release/RC-ACCEPTANCE.en.md)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/check-docs-site.mjs](../../../scripts/check-docs-site.mjs)
- [scripts/clean-package-dist.mjs](../../../scripts/clean-package-dist.mjs)
- [scripts/generate-provider-matrix.mjs](../../../scripts/generate-provider-matrix.mjs)
- [scripts/release-preflight.mjs](../../../scripts/release-preflight.mjs)
- [scripts/package-artifacts.mjs](../../../scripts/package-artifacts.mjs)
- [scripts/validate-npm-tarballs.mjs](../../../scripts/validate-npm-tarballs.mjs)
- [scripts/validate-source-archive.mjs](../../../scripts/validate-source-archive.mjs)
- [scripts/check-python-wheel.py](../../../scripts/check-python-wheel.py)
- [scripts/test-stability.mjs](../../../scripts/test-stability.mjs)
- [scripts/check-coverage.mjs](../../../scripts/check-coverage.mjs)
- [scripts/coverage-baseline.json](../../../scripts/coverage-baseline.json)
- [scripts/release-version.mjs](../../../scripts/release-version.mjs)
- [scripts/release-artifacts.mjs](../../../scripts/release-artifacts.mjs)
- [scripts/publish-npm-artifacts.mjs](../../../scripts/publish-npm-artifacts.mjs)
- [scripts/rc-acceptance.mjs](../../../scripts/rc-acceptance.mjs)
- [scripts/audit-markdown.mjs](../../../scripts/audit-markdown.mjs)
- [scripts/markdown-audit-lib.mjs](../../../scripts/markdown-audit-lib.mjs)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/docs-link-policy.test.ts](../../../scripts/docs-link-policy.test.ts)
- [scripts/provider-matrix.test.ts](../../../scripts/provider-matrix.test.ts)
- [scripts/release-preflight.test.ts](../../../scripts/release-preflight.test.ts)
- [scripts/package-artifacts.test.ts](../../../scripts/package-artifacts.test.ts)
- [scripts/coverage-baseline.test.ts](../../../scripts/coverage-baseline.test.ts)
- [scripts/workflow-contract.test.ts](../../../scripts/workflow-contract.test.ts)
- [scripts/source-archive.test.ts](../../../scripts/source-archive.test.ts)
- [scripts/release-version.test.ts](../../../scripts/release-version.test.ts)
- [scripts/release-artifacts.test.ts](../../../scripts/release-artifacts.test.ts)
- [scripts/publish-npm-artifacts.test.ts](../../../scripts/publish-npm-artifacts.test.ts)
- [scripts/rc-acceptance.test.ts](../../../scripts/rc-acceptance.test.ts)
- [scripts/markdown-audit.test.ts](../../../scripts/markdown-audit.test.ts)
- [python/tests/test_release_metadata.py](../../../python/tests/test_release_metadata.py)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [模块示例](../../../examples/modules/contribute-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/contribute-coremind/README.en.md)
- [Agent Skill](../../../skills/contribute-coremind/SKILL.md)
