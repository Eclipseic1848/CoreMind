# TypeScript SDK Guide

## When to use it

Embed runtime, tools, sessions, explicit Loops, evaluation, and events in Node applications through the single coremind-ai facade.

## Minimal example

```text
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: '执行任务',
  toolDefinitions: [lookupOrder],
});
const result = await runtime.run();
console.log(result.snapshot.operation, result.snapshot.artifacts);
if (result.outcome.status !== 'succeeded') {
  console.error(result.outcome.error?.message ?? result.outcome.finishReason);
}
```

Create `lookupOrder` with `defineTool` and a truthful declaration such as `effect: { operations: ['read'], reversible: true }`. Normal run terminal states are returned, while `catch` remains for configuration loading, runtime creation, or caller-side failures.

For independent business acceptance, use `loop.verify.mode: host`. `onVerification` only notifies the candidate; after checking the Run, requestId, candidateSha256, and business object, submit the decision with `runtime.acceptControl`. `accepted` only acknowledges receipt; inspect `result.outcome` for the terminal state. See the [offline host verification example](../../../examples/host-verification/README.en.md).

## Input during a Run (1.1 development)

Create a session with `new ChatSession(runtime, agentName)`. Once its current Run is ready, a UI action can call:

```typescript
const receipt = await session.steer('Check test results first', {
  controlId: 'review-tests-1',
  runId: activeRunId,
});
const followUp = await session.followUp('Summarize risks after the agent stops', {
  controlId: 'summarize-1',
  runId: activeRunId,
});
```

The host owns `session` and `activeRunId`; calling `chat()` does not itself prove inbox readiness. Steering enters a later available Turn; follow-up continues after the agent would naturally stop, within the same Run. Both capture the active owner instead of looking up a later Run after awaiting. Unbound, unready, sealed, or mismatched Runs reject controls. Omitting controlId creates a new ID per call; retain the original ID for retries. Identical content returns duplicate, conflicting content returns conflict.

Accepted means durably received; applied means the applied fact committed before delivery to the native agent queue. Other receipts are rejected, duplicate, and conflict. Observe `input_receipt/input_claimed/input_completed/input_discarded` through `session.onEvent`, matching inputId and TurnId. Controls do not approve tools or change budgets, permissions, or Provider. Additional input is rejected while independent host verification waits for a decision.

Accepted controls apply with their original identity after the recovered agent is ready. Applied controls without confirmed consumption are explicitly discarded, never automatically redelivered; the durable-commit/in-memory-delivery crash window remains. Paused original inputs retain their recovery gates; discarded ordinary inputs remain non-resumable. This is not absolute exactly-once delivery or a substitute for Session and compaction records in full request reconstruction.

## Explicit MCP authentication (1.1 development line)

For a service with `mcp.servers.remote.oauth`, the host owns the authentication session:

```typescript
import { CoreMindRuntime, createMcpAuthentication } from 'coremind-ai';

const authentication = await createMcpAuthentication({ config });
try {
  await authentication.login('remote', {
    signal: controller.signal,
    onAuthorization: (request, signal) => {
      signal.throwIfAborted();
      showTemporaryAuthorizationLink(request.authorizationUrl);
    },
  });
  const runtime = await CoreMindRuntime.create({
    config,
    configDir: process.cwd(),
    initialPrompt: 'Read authorized resources',
    mcpAuthentication: authentication,
  });
  const result = await runtime.run();
  console.log(result.outcome.status);
  await authentication.logout('remote');
} finally {
  await authentication.close();
}
```

The host supplies loaded `config`, `controller`, and its temporary link UI. No browser is opened automatically; do not persist the URL. Missing handlers fail with typed `mcp_auth_required` before authentication I/O. A Run without a session pauses explicitly and never starts implicit login. Runs borrow the session, allowing reuse across Runs; Child Runs reject it.

Default memory credentials require login after restart. Node hosts may supply `tokenStore` and a stable isolated `namespace`. Its `load/save/delete` records contain credentials and must never enter Worker JSON, events, or logs. Saves must be atomic and operations bounded/cancellable. Failures revoke local authorization without old-token fallback. Logout deletes the record; close clears local transactions while preserving explicit persistence. Remote revocation, cross-origin endpoints, and dynamic registration are unsupported. External-service interoperability remains unverified; see the [configuration boundary](../../en/guide/02-configuration.md#explicit-host-owned-mcp-authentication-1-1-development-line).

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/embed-coremind-typescript/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Add caller-branch tests for `failed`, `paused`, `aborted`, `timeout`, and `budget_exceeded`.
6. With `config.loop`, collect ordered `loop_state` events and verify resume does not replay completed steps or committed effects.
7. Send `result.snapshot` across boundaries instead of directly serializing the `outputs` or `messages` maps.
8. For controls, verify the target Run, duplicate/conflict, commit failure, approval waits, cancellation discard, and cold recovery. Receipts do not replace actual request content or input-event evidence.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
