# Providers and Models

Status: \`0.3.0-rc.1\` release candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Inherit the provider catalog from the locked runtime dependency while keeping availability separate from real certification.

## Public interfaces

- `buildProviderRuntime`
- `listInheritedProviders`

## Errors and boundaries

- Unknown providers or models prevent startup
- A missing apiKeyEnv produces an explicit authentication error
- Catalog discovery means configurable only; current certification covers streaming, tools, structured output, multi-turn, abort, error mapping, and long context
- Earlier evidence with missing current checks is retained with gaps but automatically downgraded to configurable and incomplete

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/provider.ts](../../../packages/coremind-runtime/src/provider.ts)
- [packages/coremind-runtime/src/provider.test.ts](../../../packages/coremind-runtime/src/provider.test.ts)
- [packages/coremind-runtime/src/integration.real.test.ts](../../../packages/coremind-runtime/src/integration.real.test.ts)
- [Certification SOP](../../providers/CERTIFICATION.en.md)
- [模块示例](../../../examples/modules/manage-providers/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-providers/README.en.md)
- [Agent Skill](../../../skills/manage-providers/SKILL.md)
