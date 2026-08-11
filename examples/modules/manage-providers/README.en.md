# Providers and Models Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
provider:
  id: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Certified status requires all seven live checks for the same version and model. Without data-egress and cost approval, validate configuration only and send no request.

Return to the [English guide](../../../docs/modules/manage-providers/GUIDE.en.md).
