# Tools and Business Capabilities Guide

## When to use it

Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract.

## Minimal example

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  effect: { operations: ['read'], reversible: true },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

`operations` describes what the tool actually does, not its business name. Use `read` for data reads, `write` for file or record changes, `process` for subprocesses, `network` for HTTP access, and `external` when none of those are sufficient. Set `reversible: true` only when the framework can restore every side effect. Declare non-standard path or URL arguments with `pathFields` and `urlFields`, for example `pathFields: ['output.path']`.

Use a business-specific tool name rather than a reserved built-in name such as `read`, `write`, or `bash`. SDK definitions and script registration reject collisions before execution.

## Coding-tool boundaries

```ts
import { GitAdapter, ProcessRunner, diffFiles } from "coremind-ai";

const tests = await new ProcessRunner().run({
  command: process.execPath,
  args: ["--test"],
  cwd: process.cwd(),
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

const git = new GitAdapter({ cwd: process.cwd() });
const status = await git.status();
const patch = await git.diff();
const preview = await diffFiles("src/before.ts", "src/after.ts");
```

`ProcessRunner` takes a command and argument array rather than a concatenated string for shell interpretation. When explicit environment variables are needed, pass only the keys required by the task and do not copy secrets into child processes by default. `GitAdapter` reads evidence and intentionally omits checkout, add, commit, reset, clean, and push. Unified diff is limited to bounded text files and fails explicitly when limits are exceeded.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/build-tools/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Test nested path escape, network denial, repeated calls, and tool exceptions; confirm policy blocks before execution.
6. Test process timeout, cancellation, output limits, missing executables, Git link escape, and oversized diffs.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
