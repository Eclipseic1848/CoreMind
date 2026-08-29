# Child Run 最小示例

本示例说明接入合同，不包含真实凭据。父 Runtime 必须配置有限 `maxTokens` 与 `maxCostUsd`。Adapter 工厂创建子 Runtime 时传入同一个 authority：

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

父级调用 `delegateChildRun(request)` 后必须在结构化 join 点执行 `handle.join()`。查看结果时使用 `result.childRuns`、Protocol v2 query 或 TUI `/children`。非成功结果，以及带 started/unknown Effect、未静止或所有权不明的异常成功结果，必须先通过 `delegation_disposition` 持久处置；安全重委派使用新身份、新预算和 `recoveryOf`。不要读取内部 Map，也不要在 orphan 后自动重新创建委派。

验收入口：

```powershell
npm.cmd run build
npm.cmd exec -- vitest run packages/coremind-runtime/src/child-run.test.ts packages/coremind-runtime/src/child-runtime-adapter.test.ts packages/coremind-runtime/src/workspace-lease.test.ts packages/coremind-worker/src/protocol-host.test.ts
```
