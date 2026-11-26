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

## Enable only ontology from an empty project

Install the service from PyPI in a dedicated Python 3.10+ environment on the business host. Put the five model files outside the environment. Set `MODEL_DIR` to their absolute directory path and supply the read credential described below.

```sh
python -m pip install coremind-ontology-mcp==0.1.0
coremind-ontology-mcp --version
coremind-ontology-mcp --model-dir "$MODEL_DIR" --port 8879
```

You can also build the wheel from the repository root with `python -m pip wheel --no-deps --wheel-dir .scratch/ontology-wheels ./components/ontology`, or install a wheel of the same version from your distributor.

A read-only project needs just the component and its model assets. Find sample models, service bindings and the external installation check in the [runnable example](../../../examples/modules/manage-ontology/README.en.md).

Supply the full Bearer header in `COREMIND_ONTOLOGY_AUTHORIZATION`. The token after `Bearer ` must have at least 24 non-whitespace characters. Bind `ontology_describe`, `ontology_validate_record` and `ontology_inspect_action` per agent for inspection, record validation and action checks. Use `modelVersion`, `modelDigest` and `bundleDigest` to identify the model and project assets used. Select `coremind-off.yaml` when the task needs no ontology. [Read-only configuration](../../../examples/modules/manage-ontology/coremind.yaml) · [Unbound configuration](../../../examples/modules/manage-ontology/coremind-off.yaml)

Connect a Streamable HTTP MCP client to `http://127.0.0.1:8879/mcp` with the credential in the `Authorization` header. With the document model, call `ontology_describe` with `{"resource":"urn:doc:guide"}` and check the object and model version. CoreMind projects can copy the `mcp.servers.ontology` binding and required Agent tool declarations from the read-only configuration and keep their own model provider. Knowledge retrieval and Hindsight services are optional.

## Bind a write action

A read credential calling `ontology_perform_action` receives `action_not_authorized`. To enable writes, bind that tool for the authorized agent and keep CoreMind tool approval in place. Set a distinct `COREMIND_ONTOLOGY_ACTION_AUTHORIZATION` and start the service with `--action-handler /abs/handler.py --receipt-db /abs/state/receipts.sqlite3`. The host explicitly selects a reviewed local Python file exporting a synchronous `execute(command)`. Its state directory must already exist and be writable.

The handler executes a business transaction keyed by `requestId` and returns `requestId`, `resource`, `previousState`, `status`, and `state`. The [sample business handler](../../../examples/modules/manage-ontology/receipt_handler.py) commits a conditional update and its business receipt in one SQLite transaction. The component separately records the request in the project’s exclusive receipt database before dispatch. Confirmed requests return the saved receipt. Missing or inconsistent receipts and interrupted writes remain `unknown`; after restart, a new write against that resource still requires reconciliation. Preserve the database and check the authoritative business system.

## Upgrade and removal

Save the five model files, versions and digests. If business actions are enabled, pause writes and preserve the host's durable receipts and unresolved requests. Start the target service separately. Repeat a known object query, a violation and an action precondition check against the same model before switching endpoints. For rollback, restore the earlier service and model, and reconcile actions already performed. To disconnect a project, remove its ontology tools, service binding and credentials. Remove the service environment only if it is dedicated to that project. The project owner keeps its models, mappings and receipts.

After stopping the dedicated process, run `python -m pip uninstall coremind-ontology-mcp`. Keep the latest receipt database through backup or rollback. Restoring an older database would discard evidence of later requests. The original 2.0.0 source demo keeps action state in memory; restrict a fallback to that version to reads. If a new model’s initial state conflicts with confirmed receipts, the component rejects writes to the resource with `model_state_conflict`.
