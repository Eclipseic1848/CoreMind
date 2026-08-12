# Context and Artifact Governance Example

## Run automated verification

```powershell
npx vitest run packages/coremind-runtime/src/context.test.ts packages/coremind-runtime/src/result.test.ts packages/coremind-tools/src/artifact-store.test.ts --maxWorkers=1
```

The tests verify byte-stable prefixes, summaries that retain critical state, a bounded preview for 50 MB output, verifiable full-file size and hash, secret blocking, and rejection of forged paths.

## Compare strategies in the embedded SDK

```typescript
import { compareContextStrategies } from "coremind-runtime";

const report = compareContextStrategies(messages, {
  contextWindow: 32_768,
  reserveTokens: 4_096,
  keepRecentTokens: 8_192,
});
console.log(report);
```

This function returns offline measurements only. It does not change runtime defaults or make a model request.

Return to the [English guide](../../../docs/modules/manage-context-artifacts/GUIDE.en.md).
