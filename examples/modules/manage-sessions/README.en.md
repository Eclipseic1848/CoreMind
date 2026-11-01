# Sessions and Context Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
session:
  enabled: true
  dir: ./.coremind/sessions
  compact: false
```

## Session tree example (1.4 development)

`npm run build`

`node examples/modules/manage-sessions/branches.mjs`

The example imports only coremind-ai and uses a local HTTP fake provider without real credentials. It checks branch isolation, persisted selection, fork provenance and continued chat, then safely removes its temporary directory. It does not replace real-provider qualification or Windows/Linux CI.

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.

Return to the [English guide](../../../docs/modules/manage-sessions/GUIDE.en.md).
