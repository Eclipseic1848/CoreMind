# Runtime Lifecycle Extensions Example

This example covers two recommended starting points: a read-only trace exporter and an additive denial policy. It never auto-loads project code.

```ts
import {
  CoreMindRuntime,
  createDenyPolicyExtension,
  createTraceExporterExtension,
} from "coremind-ai";

const received: string[] = [];
const exporter = createTraceExporterExtension({
  id: "trace-exporter",
  exporter: (event) => received.push(event.type),
});
const deny = createDenyPolicyExtension({ id: "deny-shell", deniedTools: ["bash"] });

const extensions = [exporter, deny];
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  lifecycleExtensions: {
    extensions,
    trustedIds: extensions.map((item) => item.id),
    grants: Object.fromEntries(extensions.map((item) => [item.id, item.capabilities])),
    timeoutMs: 500,
  },
});

const result = await runtime.run();
console.log(result.outcome, result.extensions, received);
```

Run the module tests and verify that `bash` never executes, no checkpoint is created before the extension denial, all four receipts are auditable, and an exporter failure cannot change `result.outcome`.

Return to the [English guide](../../../docs/modules/extend-runtime-lifecycle/GUIDE.en.md).
