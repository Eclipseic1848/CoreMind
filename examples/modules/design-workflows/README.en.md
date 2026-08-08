# Workflows and Bounded Loops Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
workflow:
  - id: draft
    type: call
    agent: writer
    input: '{{prompt}}'
    saveAs: draft
  - id: review
    type: call
    agent: reviewer
    input: '{{draft.text}}'
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.

Return to the [English guide](../../../docs/modules/design-workflows/GUIDE.en.md).
