# Connect a business ontology

## Prepare the model

Start with a business question, such as “Who reviewed this document and can it be published now?” Choose a valid instance and one whose action should be refused. Give each object a stable identifier. The [document-review model](../../../examples/modules/manage-ontology/models/document-review/) contains five project files.

| File | Project-supplied content |
| --- | --- |
| `model.ttl` | Types, parent classes, properties and relationships. The example uses `urn:review:Document` and a `reviewedBy` relationship. |
| `data.ttl` | Initial instances with stable IRIs, properties and links to other instances. |
| `mapping.json` | Mapping version, sources, identity field, confirmed identities or candidates, aliases, codes and unit conversion. |
| `shapes.ttl` | SHACL Core constraints. Each document needs one registered reviewer. Weight is a nonnegative decimal in kilograms. |
| `actions.json` | Model version, action target class, state property, allowed previous state and expected destination state. |

Both `catalog.A1` and `archive.ARCH-1` map to the confirmed `urn:doc:guide`. The two possible identities for `catalog.A2` produce `needs_confirmation`. A value of 1250 for the source field 克重 becomes 1.25 kilograms while retaining the original value and mapping version. The project owner confirms semantic equivalence. See [Turtle](https://www.w3.org/TR/turtle/) and [W3C SHACL](https://www.w3.org/TR/shacl/).

## Enable read operations

The example targets Python 3.12 with RDFLib 7.6.0, pySHACL 0.40.2, MCP 1.30.0 and Uvicorn 0.54.0. RDFLib handles the graph and pySHACL validates shapes. This adapter uses local Turtle and SHACL Core. From the repository root, install the dependencies, set the read credential and start the service. [Requirements](../../../examples/modules/manage-ontology/requirements.txt) · [RDFLib](https://pypi.org/project/rdflib/7.6.0/) · [pySHACL](https://pypi.org/project/pyshacl/0.40.2/)

```sh
python -m pip install -r examples/modules/manage-ontology/requirements.txt
python -B -X utf8 examples/modules/manage-ontology/ontology_server.py --model-dir examples/modules/manage-ontology/models/document-review --port 8879
```

Supply the full Bearer header in `COREMIND_ONTOLOGY_AUTHORIZATION`. The token after `Bearer ` must have at least 24 non-whitespace characters. Bind `ontology_describe`, `ontology_validate_record` and `ontology_inspect_action` per agent for inspection, record validation and action checks. Use `modelVersion`, `modelDigest` and `bundleDigest` to identify the model and project assets used. Select `coremind-off.yaml` when the task needs no ontology. [Read-only configuration](../../../examples/modules/manage-ontology/coremind.yaml) · [Unbound configuration](../../../examples/modules/manage-ontology/coremind-off.yaml)

## Bind a write action

The `publish` action expects a `reviewed` document and a `published` result. Inspection reports `ready` when the action is eligible. To execute it, the host starts the service with `--enable-actions`, supplies a distinct `COREMIND_ONTOLOGY_ACTION_AUTHORIZATION` and binds `ontology_perform_action` as an effectful tool to an authorized caller. CoreMind enforces its tool policy. The handler checks the current graph, target and expected state again before execution and uses the business receipt to determine the outcome.

The example supplies a synthetic receipt. A real integration must match the request ID, object, previous state and observed state. Treat a missing or inconsistent receipt as `unknown`, query the owning system and avoid replaying the write. The example records requests within the running host process. The business host owns durable receipts and reconciliation across restarts. [Host implementation](../../../examples/modules/manage-ontology/ontology_project.py) · [Acceptance procedure](SOP.en.md)
