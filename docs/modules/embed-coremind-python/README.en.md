# Python SDK and Tool Bridge

Status: published with stable `0.7.0`. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Drive the same Node runtime and explicit Loop over stdio JSON-RPC from Python, and register Python callables as agent tools.

## Public interfaces

- `CoreMindClient`
- `AsyncCoreMindClient`
- `@client.tool`
- `resume_run`
- `inspect_run`
- `checkpoint_diff`
- `checkpoint_restore`
- `CoreMind Protocol v1`
- Pure-JSON `result["snapshot"]`

## Errors and boundaries

- Protocol errors map to typed Python exceptions
- The worker stays alive instead of spawning per request
- Tool results remain JSON-serializable across languages
- `@client.tool` requires `effect`, and protocol registration validates the declaration
- Initialization or tool-registration failures close the worker immediately instead of leaving a partially started process
- `run` and `chat` return the same success, failure, pause, abort, timeout, and budget-exhaustion terminal states as TypeScript
- resume_run reuses the same safe-resume decision for paused or interrupted runs in the Node runtime
- Python and TypeScript preserve identical `loop_state` order, Loop terminals, stable snapshots, and effect receipts
- Protocol performs complete nested validation for operation, outcome, metrics, evaluation, release readiness, trace, checkpoints, artifacts, and extension receipts; any drift fails closed with `invalid_run_snapshot`
- The PyPI package continues to carry the built Node Worker and does not introduce a separate Python Runtime or Loop

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
