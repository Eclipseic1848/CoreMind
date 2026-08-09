# Providers and Models

Status: release-candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Inherit the provider catalog from the locked runtime dependency while keeping availability separate from real certification.

## Public interfaces

- `buildProviderRuntime`
- `listInheritedProviders`

## Errors and boundaries

- Unknown providers or models prevent startup
- A missing apiKeyEnv produces an explicit authentication error

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/provider.ts](../../../packages/coremind-runtime/src/provider.ts)
- [packages/coremind-runtime/src/provider.test.ts](../../../packages/coremind-runtime/src/provider.test.ts)
- [packages/coremind-runtime/src/integration.real.test.ts](../../../packages/coremind-runtime/src/integration.real.test.ts)
- [模块示例](../../../examples/modules/manage-providers/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-providers/README.en.md)
- [Agent Skill](../../../skills/manage-providers/SKILL.md)
