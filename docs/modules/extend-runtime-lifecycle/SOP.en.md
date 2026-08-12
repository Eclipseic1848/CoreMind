# Runtime Lifecycle Extensions Development SOP

## 1. Decide whether an extension is necessary

1. Do not create an extension when configuration, the Tool API, workflows, or ordinary event subscriptions solve the problem.
2. Record the required event, input fields, output side effects, failure behavior, and owner.
3. Stop if the design needs to change approvals, checkpoints, terminal states, or provider-private objects; those are outside the public surface.

## 2. Define capabilities and trust

1. Use a stable lowercase id and an explicit version.
2. Declare `files`, `process`, `network`, `credentials`, and `ui`; request the minimum.
3. Register the extension in host code, add its id to `trustedIds`, and grant only required capabilities.
4. Never scan a workspace or infer trust from file presence.

## 3. Implement handlers

1. Handle only required events and treat payloads as read-only.
2. A `before-tool` handler may return `{ deny: { reason } }` or no decision.
3. Export only required fields. Never record credentials, complete private user data, or provider-private objects.
4. Keep handlers idempotent, short, and bounded. External failure must be visible in receipts without changing Runtime outcome.

## 4. Failure and security tests

1. Test synchronous and asynchronous handlers.
2. Inject a never-settling promise and verify a `timed_out` receipt plus truthful Runtime completion.
3. Inject a failure and verify redaction and isolation.
4. Deny a tool in shared or human policy and verify the extension cannot execute or rewrite denial.
5. Let shared policy allow, then deny in the extension; verify no tool or checkpoint runs.
6. Verify `run-finished` sees the true completed, paused, or failed operation.
7. Verify outputs contain no test key, authorization header, cookie, private key, sensitive URL parameter, or command secret, while ordinary business fields remain intact.

## 5. Delivery and rollback

1. Run the module tests and `npm run check:modules`.
2. Execute the same interactive cases on Windows and Linux.
3. Preserve the extension version, grants, timeout, trace, and receipts.
4. Roll back by removing the extension from `extensions`, `trustedIds`, and `grants`; retain audit evidence.
5. Do not commit, push, or publish without explicit authorization.
