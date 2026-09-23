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

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
