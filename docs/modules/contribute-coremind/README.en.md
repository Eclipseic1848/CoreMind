# Source and Community Contribution

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Change CoreMind source within its one-way dependencies, test-first workflow, bilingual material contract, and release authorization boundary.

## Public interfaces

- `npm run build`
- `npm test`
- `npm run check`
- `npm run check:modules`
- `npm run docs:build`
- `npm run providers:matrix`
- `npm run release:preflight`

## Errors and boundaries

- Dependencies must remain config to tools to templates to runtime to facade/CLI/worker
- Never push, tag, or publish without authorization
- Preserve unrelated user changes
- Provider discovery is not certification; releases require live evidence

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [package.json](../../../package.json)
- [vitest.config.ts](../../../vitest.config.ts)
- [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)
- [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [SECURITY.md](../../../SECURITY.md)
- [docs/.vitepress/config.mts](../../../docs/.vitepress/config.mts)
- [docs/providers/certifications.json](../../../docs/providers/certifications.json)
- [docs/release/README.zh-CN.md](../../../docs/release/README.zh-CN.md)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/check-docs-site.mjs](../../../scripts/check-docs-site.mjs)
- [scripts/clean-package-dist.mjs](../../../scripts/clean-package-dist.mjs)
- [scripts/generate-provider-matrix.mjs](../../../scripts/generate-provider-matrix.mjs)
- [scripts/release-preflight.mjs](../../../scripts/release-preflight.mjs)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/docs-link-policy.test.ts](../../../scripts/docs-link-policy.test.ts)
- [scripts/provider-matrix.test.ts](../../../scripts/provider-matrix.test.ts)
- [scripts/release-preflight.test.ts](../../../scripts/release-preflight.test.ts)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [模块示例](../../../examples/modules/contribute-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/contribute-coremind/README.en.md)
- [Agent Skill](../../../skills/contribute-coremind/SKILL.md)
