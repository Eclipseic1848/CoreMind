# Checkpoints, Diffs, and Restore Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
/checkpoints
/diff CHECKPOINT_ID
/restore CHECKPOINT_ID
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. After a tool writes a file, edit it manually and run `/restore ID`; expect `checkpoint_conflict` and verify the manual content remains unchanged.

Return to the [English guide](../../../docs/modules/manage-checkpoints/GUIDE.en.md).
