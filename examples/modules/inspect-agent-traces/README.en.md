# Trace, RunState, and Debugging Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
runtime = await CoreMindRuntime.create({
  config,
  configDir,
  trace: (entry) => console.log(entry.sequence, entry.event.type),
});
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Pass a test-only fake `apiKey`, body, and URL query secret; confirm Trace/RunState exclude the original values while the target path remains visible.

Return to the [English guide](../../../docs/modules/inspect-agent-traces/GUIDE.en.md).
