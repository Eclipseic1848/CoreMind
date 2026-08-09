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
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Remove `effect` and confirm Python rejects registration before execution; restore it and verify the tool call succeeds.
6. Make a test worker reject one registration and confirm no child process or locked temporary directory remains after the exception.

Return to the [English guide](../../../docs/modules/embed-coremind-python/GUIDE.en.md).
