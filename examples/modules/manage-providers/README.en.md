# Providers and Models Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
provider:
  id: alibaba-model-studio
  model: qwen-plus
  apiKeyEnv: DASHSCOPE_API_KEY
```

This provider/model pair passed live certification in the `0.8.0` release candidate. Reverify other credentials or environments; see the [Provider module](../../../docs/modules/manage-providers/README.en.md) for the evidence scope.

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. You can validate this configuration locally. For 2.0.0 certification, obtain data-egress and cost approval and use the same version, provider, and model for the seven base checks and five checks covering the parent/child call chain and cancellation convergence. Follow the [provider certification SOP](../../../docs/providers/CERTIFICATION.en.md).

Return to the [English guide](../../../docs/modules/manage-providers/GUIDE.en.md).
