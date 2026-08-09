# Configuration and Schema Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
schemaVersion: 2
name: support-agent
agents:
  main:
    systemPrompt: 你是客服助手
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
runtime:
  maxTurns: 12
quality:
  profile: standard
```

When adding a custom script tool, declare its effects with this structure:

```yaml
agents:
  main:
    tools:
      - path: tools/save-report.mjs
        effect:
          operations: [write]
          reversible: true
          pathFields: [output.path]
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.

Return to the [English guide](../../../docs/modules/configure-coremind/GUIDE.en.md).
