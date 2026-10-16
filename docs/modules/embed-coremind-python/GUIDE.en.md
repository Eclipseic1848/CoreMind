# Python SDK and Tool Bridge Guide

## When to use it

Drive the same Node runtime over stdio JSON-RPC from Python. Default Protocol v1 can register Python callables as agent tools; choose Protocol v2 explicitly for host verification.

## Minimal example

```text
with CoreMindClient(config_path='coremind.yaml') as client:
    @client.tool(
        description='查询模拟订单',
        effect={'operations': ['read'], 'reversible': True},
    )
    def lookup_order(order_id: str) -> dict[str, str]:
        return {'id': order_id, 'status': 'paid'}
    result = client.run('查询 A-100')
    print(result['snapshot']['operation'], result['snapshot']['artifacts'])
    if result['outcome']['status'] != 'succeeded':
        raise RuntimeError(result['outcome']['finishReason'])
```

The example above uses default Protocol v1. For host verification in `0.8.0`, use `CoreMindClient(..., protocol_version="2.0")`: `run()` first returns a RunHandle; check `received_verification_requests`, submit the host decision with `submit_verification`, and read the final Projection outcome with `query(runId)`. V2 does not execute `@client.tool` Python callables. See the [host verification example](../../../examples/host-verification/README.en.md).

In v1, `effect` travels with `register_tool` to the shared runtime. Use `pathFields` and `urlFields` for non-standard arguments. Terminal states live in `result['outcome']`; Python exceptions remain for protocol, startup, and caller failures.

If initialization or any tool registration fails, the client closes the started worker before returning the exception. Continue to use a context manager or `finally` for the normal lifecycle.

## Controls during a Run (1.1 development)

Python retains existing Protocol v2 `control`, `events`, and `query` methods without a new convenience API or protocol version. Select `protocol_version="2.0"` explicitly. The default Worker comes from the installed package, not a source checkout. For a ready active Run, take `run_id` from its RunHandle:

```python
receipt = client.control({
    'schemaVersion': 1,
    'runId': run_id,
    'controlId': 'review-tests-1',
    'type': 'steering',
    'message': 'Check test results first',
})
page = client.events(run_id, after_sequence=0)
```

Type can be `steering` or `follow_up`; follow-up continues in the same Run after the agent would naturally stop. Await the corresponding AsyncCoreMindClient methods for the same contract. Every `events` call requires explicit `after_sequence`. Save the last read sequence and advance it for catch-up; an empty page is not a terminal result. Use events or `query` to check the final outcome.

Retain controlId for retries: identical content returns duplicate, different content returns conflict. Other receipts are accepted, applied, and rejected. Accepted means durably received; applied means the applied fact committed before delivery to the agent queue. Neither proves model consumption. Match independent `input_receipt/input_claimed/input_completed/input_discarded` events by inputId. Wrong, unready, or sealed Runs reject controls. Controls neither approve tools nor change permissions or budgets, and they start no concurrent Run.

Cold recovery may apply accepted controls. Applied controls without confirmed consumption are explicitly discarded rather than automatically redelivered; the durable-commit/in-memory-delivery crash window remains. Paused original inputs remain resumable under existing gates; discarded ordinary inputs do not. Control receipts do not replace Session content or full conversation reconstruction. Default v1 clients and the tool bridge retain their existing contract. See the [bundled Worker regressions](../../../python/tests/test_runtime_controls.py).

## Explicit MCP login (1.1 development line)

Interaction requires a new Worker negotiating `mcpAuthentication`, explicit v2, and a dedicated handler:

```python
from coremind import CoreMindClient

def show_authorization(request):
    show_temporary_link(request['authorizationUrl'])

with CoreMindClient(config, protocol_version='2.0',
                    mcp_auth_handler=show_authorization) as client:
    client.mcp_login('remote', transaction_id='login-1')
    handle = client.run('Read authorized resources')
    # 按 handle 的 runId 补读 events/query，直到真实终态。
    client.mcp_logout('remote')
```

The host supplies `config` and the temporary link UI. Wait for the Run's actual terminal state before logout. The reader only validates and queues; sync handlers run on the login caller's thread. Another thread can call `mcp_cancel_auth('login-1')` and wait for Node cleanup. Handler errors also cancel that transaction. Handlers must return within a bounded time.

Use the same constructor arguments with `AsyncCoreMindClient` and await the three authentication methods. Async handlers run on the original event loop. Cancelling the login Task cancels its handler, sends cancellation for the owned Node transaction, and joins cleanup instead of merely abandoning Python's wait. Never reuse an active transaction ID or cancel another login's transaction.

Default v1 or a missing handler fails before authentication requests with `protocol_capability_missing` or `mcp_auth_required`. Old v2 Workers still fail the exact schema fingerprint check; interaction is never silently downgraded. Dedicated authorization notifications do not enter `received_events`. Tokens, callback codes, and verifiers remain in Node. Python has no TokenStore seam and creates no default plaintext files. Memory credentials span Runs in one client and disappear on close; local logout does not promise remote revocation. External-service interoperability remains unverified; see the [configuration boundary](../../en/guide/02-configuration.md).

## Tool discovery and Worker compatibility (1.1 development line)

[Deferred tool configuration](../../en/guide/02-configuration.md#deferred-tool-exposure-11-development-line) requires explicit Config 3. Existing Config 2 files omitting `exposure` keep their behavior. Python uses the existing `run/chat` methods; the same Node Runtime owns search and declaration installation, without another configuration process or a Python tool catalog.

Default v1 retains its original first initialize packet with no `capabilities` field. Only `protocol_capability_missing` with details exactly `{schemaVersion: 1, requiredCapabilities: ['toolDiscovery'], retryInitialize: true}` permits at most one retry in the same process, adding only `toolDiscovery`. Ordinary errors and malformed challenges are not retried, and success must acknowledge that capability. V2 declares the capability in its first packet and checks the exact schema fingerprint and capability receipt, without fallback. Older Workers must reject Config 3 before any Run; older SDKs that do not understand the challenge fail explicitly.

A search match does not approve execution. Durable installation at the next request still preserves approval and deny rules. New Runs rebuild declarations; the same Run retains its configuration-fingerprint resume gate. Optional `toolDiscovery` fields on `context_prefix` and `provider_request` carry only the five-field safe summary, which Python validates as a closed object. Complete catalogs and schemas never travel through public events. These are usage and protocol contracts, not claims of external interoperability or completed release qualification.

`resume_run` reuses an installed tool set only when the latest authoritative pause exactly binds the execution to continue. Quality retries start new executions. After a crash without that binding, existing resume admission may allow a fresh deferred declaration, never activation borrowed from the same Run/Agent/Step. Node manages this binding in private facts; it adds no Python catalog, public owners field, or complete-message-recovery promise. Configuration fingerprints, input, approval, and effect checks still apply.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/embed-coremind-python/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. For v1 results, verify Python and TypeScript expose the same six terminal states, tool effects, and approval fields; in v2, check the Projection outcome with `query(runId)`.
6. For the v1 tool bridge only, inject a registration failure and confirm `client.pid` is cleared and the temporary directory can be removed.
7. For an explicit Loop, compare Python and TypeScript `loop_state` order, then call `resume_run` after pause and confirm committed effects do not replay.
8. For v1, verify `result['snapshot']` matches top-level runId, outcome, operation, metrics, and trace. Stop using a Worker that reports `invalid_run_snapshot`.
9. For v2 host verification, catch up with `events` by RunId and sequence, confirm rejection repairs within the same Run, and distinguish control receipts from the final outcome.
10. For v2 input controls, verify sync/async, duplicate/conflict, cancellation discard, and no queue leakage into the next Run, retaining real request and input-event evidence.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.

## Worker output delivery limits

The bundled Worker's stdout queue plus in-flight data are limited to **64 MiB of encoded UTF-8 and 1024 messages**, with at most 64 MiB per message. Required RPC responses, approval/tool/authentication notifications, and control receipts never disappear silently when the queue is full. Other existing best-effort `event` notifications may be dropped when the total budget is exhausted. A v2 host can catch up with durable `events`, using each Run's actual page `nextCursor`; live notification `sequence` is a separate counter and cannot serve as that cursor. V1 has no equivalent durable catch-up guarantee. An oversized single message still fails the transport.

Normal write/drain waits do not pause input, so approval, cancel, and tool_result messages remain processable. Hard overflow, a broken pipe, or a write error starts one shutdown: stop new input, cancel the active Run, reject pending tools and approvals, and await the existing quiescence check. EOF also waits for shutdown, then gives already accepted RPC responses and the actual output flush a shared **10-second** deadline. Failure to reach quiescence is not success. When stdout is unavailable, an error response or cancel ACK cannot be guaranteed. The Worker reports delivery failure through a nonzero exit status and an `output_delivery_failed` stderr diagnostic; Python may raise the existing `WorkerExitedError`, so a JSON-RPC error carrying that code is not guaranteed.

This is a bounded transport failure contract. Runtime synchronous event callbacks have not become asynchronous backpressure. The limits exclude transient JSON encoding memory, upstream response generation, and receiver resources. The transport does not rewrite existing persisted Facts or grant permissions. Runtime still records its own cancellation and cleanup outcome; delivery failure is not fabricated as business completion and does not trigger automatic replay of potentially effectful work.

The 10-second limit bounds delivery waiting, not forced termination of a physical stream or uncooperative JavaScript. Logical close returns without an unbounded wait; an outstanding owned write retains only one error guard and its close cleanup listener until that callback or stream close settles. A timeout is not proof that all accepted operations are quiescent; related resources must not be released or reused on that assumption.
