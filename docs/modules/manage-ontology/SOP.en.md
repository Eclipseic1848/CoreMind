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

## P3 development verification

- Windows Python 3.12 and the Linux Python 3.13 container each passed 15 tests covering two interchangeable domain models, field normalization, real SHACL reports, and action receipts.
- On Windows, the four entry points passed all 12 enabled, disabled, and damaged model cases. Additional checks covered a read-only token, denied approval, failed draft preconditions, state readback after approval, and replay of the same request ID.
- A transport outage produced zero model requests. With a missing business receipt, the Runtime recorded `started` and `unknown`, and a new request could not repeat the write to the same target.
- Three cross-session summaries covered versioned citations, an approved table preference and a blocked draft publication, and citation withdrawal after a preference correction. The run exercised the service adapters, tools, and ontology engine with deterministic index, memory storage, and model fixtures.
