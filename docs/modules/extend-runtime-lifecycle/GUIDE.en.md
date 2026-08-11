# Runtime Lifecycle Extensions Guide

## When to use it

Use an extension only when trace export, run metrics, or an organization-level tool denial cannot be expressed through existing configuration. Business tools should use the stable Tool API, and business workflows should remain configuration-driven.

## Minimal deny policy

```ts
import { CoreMindRuntime, createDenyPolicyExtension } from "coremind-ai";

const extension = createDenyPolicyExtension({
  id: "deny-shell",
  deniedTools: ["bash"],
});

const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  lifecycleExtensions: {
    extensions: [extension],
    trustedIds: [extension.id],
    grants: { [extension.id]: extension.capabilities },
    timeoutMs: 500,
  },
});
```

This policy may deny `bash` only after the shared permission policy allows it. It cannot turn a denied operation into an allowed one.

## Trace exporter

```ts
import { createTraceExporterExtension } from "coremind-ai";

const exported: unknown[] = [];
const exporter = createTraceExporterExtension({
  id: "local-trace-exporter",
  exporter: async (event) => exported.push(event),
});
```

Keep exporters short and bounded. Inspect `result.extensions` after a failure; Runtime `outcome` remains the only truthful terminal state.

## Verification

```powershell
npx vitest run packages/coremind-runtime/src/lifecycle-extension.test.ts packages/coremind-runtime/src/runtime.test.ts
npm run check:modules
```

Before release, verify synchronous, asynchronous, timeout, failure, approval-denial, checkpoint-order, and abort cases on Windows and Linux.
