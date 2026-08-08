# Python SDK and Tool Bridge

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Drive the same Node runtime over stdio JSON-RPC from Python and register Python callables as agent tools.

## Public interfaces

- `CoreMindClient`
- `AsyncCoreMindClient`
- `@client.tool`
- `resume_run`
- `inspect_run`
- `checkpoint_diff`
- `checkpoint_restore`
- `CoreMind Protocol v1`

## Errors and boundaries

- Protocol errors map to typed Python exceptions
- The worker stays alive instead of spawning per request
- Tool results remain JSON-serializable across languages
- resume_run reuses the same safe-resume decision in the Node runtime

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [python/src/coremind](../../../python/src/coremind)
- [packages/coremind-worker/src](../../../packages/coremind-worker/src)
- [packages/coremind-protocol/src](../../../packages/coremind-protocol/src)
- [python/tests/test_client.py](../../../python/tests/test_client.py)
- [python/tests/test_node_parity.py](../../../python/tests/test_node_parity.py)
- [packages/coremind-worker/src/server.test.ts](../../../packages/coremind-worker/src/server.test.ts)
- [packages/coremind-protocol/src/protocol.test.ts](../../../packages/coremind-protocol/src/protocol.test.ts)
- [模块示例](../../../examples/modules/embed-coremind-python/README.zh-CN.md)
- [Module example](../../../examples/modules/embed-coremind-python/README.en.md)
- [Agent Skill](../../../skills/embed-coremind-python/SKILL.md)
