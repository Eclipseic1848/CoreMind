# Runtime Dependency Adapter Example

Application code reads the CoreMind-owned compatibility report without importing low-level types:

```ts
import { inspectRuntimeCompatibility } from "coremind-ai";

const report = inspectRuntimeCompatibility();
if (!report.capabilities.streaming || !report.capabilities.abort) {
  throw new Error("The current Runtime does not meet application requirements");
}
console.log(report.dependencyFamily, report.adapterVersion);
```

## Verification

1. Run `npm run dependencies:check` and confirm the three critical packages use one exact version.
2. Run the adapter, Provider, tool, and Session tests in the module manifest.
3. Run `coremind doctor .\coremind.yaml` and confirm compatibility is observable.
4. Inject one Provider failure and one abort, then verify outcome semantics do not drift.

A business adapter should accept CoreMind-owned inputs and return CoreMind-owned results. If it must expose low-level objects to application callers, the seam is misplaced.

Return to the [English guide](../../../docs/modules/adapt-runtime-dependencies/GUIDE.en.md).
