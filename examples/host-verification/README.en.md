# Host verification within one Run

[中文](README.md)

This capability is under development on this branch. The published 0.7.1 packages do not provide it. Build this source checkout first:

```sh
npm run build
node examples/host-verification/demo.mjs
```

The example uses only a localhost model substitute. The host rejects the draft; CoreMind's existing Loop repairs it within the same Run; a durable host acceptance permits success. It makes two model requests, with no additional verification model and no host-owned repair loop.

`onVerification` only notifies. Returning true or PASS does not accept a candidate. Respond through `acceptControl`, binding the Run, request ID and candidate SHA-256. Unknown results, timeouts and paused states are not acceptance.

In a consumer application, replace the example's string comparison with independent host validation. Source ownership, grants, partial-result policy and final delivery remain host responsibilities. The text digest does not automatically validate external artifacts or business objects.

## Python host integration

Use the Python package and bundled Worker built from the same development commit. Create `CoreMindClient` with `protocol_version="2.0"` and configure `loop.verify.mode="host"`. The existing Loop configuration still owns execute, repair, maxIterations and maxRepairs.

After `client.run(...)` returns a RunHandle, the host event handler reads `client.received_verification_requests`. The SDK validates the notification structure and text digest. This fragment handles one request; `accepted` and `feedback` must come from independent host validation, not a model-generated PASS:

```python
def reply_to_candidate(client, request, *, accepted, feedback, control_id):
    return client.submit_verification(
        request["runId"],
        request["requestId"],
        request["candidateSha256"],
        decision="accept" if accepted else "reject",
        feedback=feedback,
        control_id=control_id,
    )
```

The host must bind each request to its own Run and business object. Persist a stable control_id for each decision; retry unknown transport results with the same ID and content. Rejection feedback must be nonempty and contain no secrets. Track handled notification identities instead of repeatedly accepting the whole list. Async clients read notifications through `sync_client.received_verification_requests` and reply with `await client.submit_verification(...)`.

`applied` means the decision is durable, not that business delivery is complete. Query `client.query(run_id)` and inspect the projection outcome. `accepted` only acknowledges receipt; `duplicate` alone does not prove Run success. Do not deliver paused or unknown results. After restart, preserve the configuration and storage directory, call `resume_run(run_id)`, and handle the recovered request. The host must not start a separate repair Run.

The executable [Python integration test](../../python/tests/test_host_verification.py) covers rejection/repair, cancellation and client restart using only a localhost substitute.

The [contract](../../docs/spec/0.7.x/03-host-verification.md) defines persistence, bounded repair, identity and cancellation. This example neither contacts a real Provider nor publishes a release.
