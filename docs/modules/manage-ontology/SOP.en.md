# Optional ontology development procedure

Start with a business question. Record the field meanings, actor, evidence of success and examples that need human confirmation. Freeze the vocabulary, instances, shapes, mapping and action assets. Retain the model version, model digest, bundle digest and mapping version. For each check, record the entry point, input, observed result and code or asset version.

| Check | Input and acceptance criterion |
| --- | --- |
| 06.01 Objects and relationships | Inspect a known instance, its type, properties, outgoing relationship and target IRI, then query an unknown resource. Replace the vocabulary, relationships and instances with a second model and exercise the same interface. |
| 06.02 Concept alignment | Map identifiers from two sources to one confirmed object. Check state codes, aliases, units, original values and mapping version. Ambiguous identities, conflicting aliases and unknown codes must give `needs_confirmation` with an empty mapping graph. |
| 06.03 Constraints | Test a valid record, a missing reviewer, a wrong datatype and a graph without constraints using a fixed version. Check `conforms`, `violates` and which rules actually apply. A broken model or failed engine should give `unavailable`. Capture the violating resource, property and rule. |
| 06.04 Actions | Check the target class, previous state and expected outcome of `publish`. Expect zero handler calls on the wrong target, failed prerequisites, a read-only credential or a denied tool policy. Match the request, target and state in the business receipt. |
| Unknown outcome | Simulate a lost acknowledgement after the handler accepted a request and a receipt with an unexpected state. Record `unknown` and check the execution count. Reading the same receipt may reuse it. A different request ID must not bypass the pending effect. |
| Entry-point parity | Run CLI/YAML, TypeScript, synchronous Python and asynchronous Python. An enabled model should yield the same resource and version; an unbound run should need no ontology connection; a model-load failure should report unavailable validation. Record a transport outage separately from a business violation. |

Run the checks below from the repository root. The four-entry-point check starts a local scripted model and temporary ontology services. Set `COREMIND_ONTOLOGY_PYTHON` to the Python 3.12 interpreter with the dependencies installed. The example covers Node workspace, Python SDK and Worker setup.

```sh
python -B -X utf8 -m unittest discover -s examples/modules/manage-ontology -p "test_*.py"
node examples/modules/manage-ontology/acceptance.mjs
npm run check:modules
```

Attach the four entry-point results, actual execution counts and model and mapping versions to the acceptance record. When rules change, run the same inputs against both versions and check that observed differences match the intended change. [Runnable example](../../../examples/modules/manage-ontology/README.en.md) · [Module manifest](module.yaml)

## Standalone wheel acceptance

In an empty business directory outside the checkout and a fresh Python environment, install only the ontology component. For 0.1.0, run `python -m pip install coremind-ontology-mcp==0.1.0`. Record the distribution source, version and digest. Take the checkout out of reach, load business-supplied model files and use a standard MCP client to query one object, detect a constraint violation and confirm that the read credential cannot execute an action. Switch to a second model with the same component and check the reported model version and digest.

Use the 2.0.0 source service as the upgrade baseline for the first packaged version. Rehearse upgrade and rollback against copies. Verify existing object IRIs, mappings, SHACL results and business receipts. Check that unresolved writes are never replayed. Remove the ontology binding and verify that the rest of the host still runs. Retain its models and receipts when removing a dedicated service environment.

The 0.1.0 external installation check uses an independent environment and the MCP client protocol to read the model, check three mapping outcomes, and exercise separate credentials and action prerequisites. The process exits after a business commit. Across a model upgrade and rollback, the lost request remains unknown, a new ID is blocked, and the business table has two actual receipts. [Repeat the check](../../../examples/modules/manage-ontology/README.en.md)

## Verify host action receipt reconciliation

1. Start a wheel built from the current source with a distinct reconciliation credential and `--receipt-db`. Have the test handler terminate the gateway after the transaction commits and before a response reaches the client. Restart and check that the old request is `unknown` and a new request for the same resource is blocked. Retain the original business transaction and component receipt.
2. Retrieve the authoritative business receipt by its original request ID. Verify 401 for the read, action and wrong reconciliation credentials, 400 for a malformed body, and 404 for an unregistered request ID. Submit evidence with the wrong resource, previous state, destination or bound model. Verify 409, continued blocking, and zero additional handler calls.
3. Submit the verified `completed` outcome with the correct host credential. Check HTTP 200 and the expected destination state. In a control where the business system confirms zero effect, submit `failed` and preserve the previous state. Identical evidence must return `replayed: true` on a repeat. Conflicting evidence stays rejected. Compare the component journal with the business ledger and verify that the completed request accounts for exactly one business transaction and the zero-effect control accounts for none.
4. Read the terminal result back over MCP by its original action and request ID, and verify the resource with `ontology_describe`. Restart to check persistence. Use a fresh request ID for a follow-up action that meets its prerequisites. Verify that reconciliation and readback did not call the handler and that the follow-up created its own transaction. Review the original CoreMind Run under its existing unknown-effect recovery policy.

Run the [installed reconciliation example](../../../examples/modules/manage-ontology/README.en.md#verify-action-receipt-reconciliation). Retain the latest copies of both databases, model digests, HTTP results, MCP readback and call counts.

## Backup and isolated recovery verification

Use the [minimal deployment and recovery example](../../../examples/modules/manage-ontology/deployment/README.en.md) to install the public wheel in two dedicated environments. Check authenticated `/health` and a known object query. Run the synthetic writes and stop writers before taking a coordinated backup of the model, handler, component journal and business SQLite database. Restore into a fresh directory. Verify completed and unresolved receipts, blocked replacement IDs and zero additional business handler calls. Reopen the restored directory with the first service environment and verify the same digest and outcomes. Record startup times and snapshot bytes. Record the same-version environment replacement and the model-version rollback separately.

## P3 development verification

Use the [offline capability regression](../evaluate-agents/SOP.en.md#regression-for-the-five-optional-capabilities) to retain receipts for denial, completion, replay, uncertain effects and blocked replacement requests. Verify request ID, target, previous state and outcome. Replay must return the same business receipt.

- Windows Python 3.12 and the Linux Python 3.13 container each passed 15 tests covering two interchangeable domain models, field normalization, real SHACL reports, and action receipts.
- On Windows, the four entry points passed all 12 enabled, disabled, and damaged model cases. Additional checks covered a read-only token, denied approval, failed draft preconditions, state readback after approval, and replay of the same request ID.
- A transport outage produced zero model requests. With a missing business receipt, the Runtime recorded `started` and `unknown`, and a new request could not repeat the write to the same target.
- Three cross-session summaries covered versioned citations, an approved table preference and a blocked draft publication, and citation withdrawal after a preference correction. The run exercised the service adapters, tools, and ontology engine with deterministic index, memory storage, and model fixtures.
