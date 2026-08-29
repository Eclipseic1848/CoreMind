# Minimal Child Run Example

This example shows the integration contract and contains no real credentials. The parent Runtime needs finite `maxTokens` and `maxCostUsd`. The adapter factory passes the same authority object into the child Runtime:

```ts
const adapter = createCoreMindChildRunAdapter({
  createRuntime: (authority) =>
    CoreMindRuntime.create({
      config: childConfig,
      configDir,
      cwd: authority.request.workspace.canonicalRoot,
      initialPrompt: authority.request.task,
      runId: authority.childRunId,
      signal: authority.signal,
      childRunAuthority: authority,
    }),
});
```

After `delegateChildRun(request)`, the parent must call `handle.join()` at the structured join point. Inspect `result.childRuns`, Protocol v2 query, or TUI `/children`. Persist a `delegation_disposition` before continuing from a non-successful result or an anomalous success with a started/unknown Effect, non-quiescence, or uncertain ownership. Safe redelegation uses a new identity, a new budget, and `recoveryOf`. Do not read internal maps or recreate an orphan automatically.

Run the focused acceptance tests:

```powershell
npm.cmd run build
npm.cmd exec -- vitest run packages/coremind-runtime/src/child-run.test.ts packages/coremind-runtime/src/child-runtime-adapter.test.ts packages/coremind-runtime/src/workspace-lease.test.ts packages/coremind-worker/src/protocol-host.test.ts
```
