# Python SDK and Tool Bridge Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
with CoreMindClient(config_path='coremind.yaml') as client:
    @client.tool(
        description='查询模拟订单',
        effect={'operations': ['read'], 'reversible': True},
    )
    def lookup_order(order_id: str) -> dict[str, str]:
        return {'id': order_id, 'status': 'paid'}
    result = client.run('查询 A-100')
    print(result['snapshot'])
```

The example above uses the default Protocol v1 callable bridge. Host verification uses `protocol_version="2.0"`: `run()` returns a RunHandle, the host replies with `submit_verification`, and `query(runId)` reads the final result. V2 does not execute Python callables. See the [host verification example](../../host-verification/README.en.md).

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Remove `effect` and confirm Python rejects registration before execution; restore it and verify the tool call succeeds.
6. Make a test worker reject one registration and confirm no child process or locked temporary directory remains after the exception.
7. Tamper with a test Worker's snapshot schemaVersion or outcome and verify the SDK reports `invalid_run_snapshot` instead of accepting inconsistent state.

Return to the [English guide](../../../docs/modules/embed-coremind-python/GUIDE.en.md).

## Offline durable task example

```text
npm run build:python-worker
python -m pip install ./python
python -X utf8 examples/modules/embed-coremind-python/tasks.py
```

task-host.mjs registers trusted definitions; tasks.py demonstrates sync/async reopen, wake, completion and cancellation with no real model requests.

The composition covers phase A, a durable wait, actual Node Worker exit/restart, explicit wake, saved-result reuse and phase B. It checks different process identities, the original Run/key/result and one execution record. Canary effects are explicitly declared and approved by the trusted host; this does not guarantee external exactly-once.
