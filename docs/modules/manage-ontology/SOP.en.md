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

## P3 development verification

- Windows Python 3.12 and the Linux Python 3.13 container each passed 15 tests covering two interchangeable domain models, field normalization, real SHACL reports, and action receipts.
- On Windows, the four entry points passed all 12 enabled, disabled, and damaged model cases. Additional checks covered a read-only token, denied approval, failed draft preconditions, state readback after approval, and replay of the same request ID.
- A transport outage produced zero model requests. With a missing business receipt, the Runtime recorded `started` and `unknown`, and a new request could not repeat the write to the same target.
- Three cross-session summaries covered versioned citations, an approved table preference and a blocked draft publication, and citation withdrawal after a preference correction. The run exercised the service adapters, tools, and ontology engine with deterministic index, memory storage, and model fixtures.
