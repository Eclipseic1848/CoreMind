# Context and Artifact Governance Guide

## No configuration is normally required

The shared runtime automatically applies the stable prefix, threshold checks, deterministic summary, and large-output capture. These mechanisms create no project-memory file and do not change the permission mode.

Inspect the TypeScript SDK result after a run:

```typescript
console.log(result.metrics.context);
console.log(result.metrics.artifacts);
console.log(result.artifacts ?? []);
```

`promptCacheStatus` reports whether the locked model catalog explicitly declares cache pricing. `cacheReadTokens` and `cacheWriteTokens` come only from real provider usage.

## Inspect large output

When a tool such as bash exceeds the model preview limit, the model receives a head, tail, and reference:

```text
[Artifact: .coremind/artifacts/<id>.log; sha256=<hash>; mediaType=text/plain; retention=run]
```

Verify on PowerShell:

```powershell
Get-ChildItem -LiteralPath .\.coremind\artifacts
Get-FileHash -Algorithm SHA256 -LiteralPath .\.coremind\artifacts\<id>.log
```

Verify on Linux:

```bash
ls -lah ./.coremind/artifacts
sha256sum ./.coremind/artifacts/<id>.log
```

## Cleanup

`retention=run` expresses retention intent; it does not delete evidence immediately when a run ends. Embedded SDK users can call `ArtifactStore.cleanup()` explicitly after audit completion. Do not remove files still referenced by traces, defect reports, or acceptance evidence.

## Common questions

- No artifact appears: output may be below the limit or blocked as a suspected credential.
- Cache is available but hits are zero: this is a valid, truthful result.
- The task drifts after compaction: inspect the fingerprinted summary for goals and unfinished work, then compare candidates.
- Cross-project knowledge is needed: design an explicit business knowledge store; this module never harvests project memory automatically.

See the [SOP](SOP.en.md) and [example](../../../examples/modules/manage-context-artifacts/README.en.md).
