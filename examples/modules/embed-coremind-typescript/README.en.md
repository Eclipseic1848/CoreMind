# TypeScript SDK Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: '执行任务',
  toolDefinitions: [lookupOrder],
});
const result = await runtime.run();
console.log(JSON.stringify(result.snapshot));
if (result.outcome.status !== 'succeeded') throw new Error(result.outcome.finishReason);
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Add `effect` to `lookupOrder` and verify `defineTool` rejects a missing declaration.
6. Serialize `result.snapshot` and verify runId, operation, outcome, trace, checkpoints, and artifacts are pure JSON.

Return to the [English guide](../../../docs/modules/embed-coremind-typescript/GUIDE.en.md).
