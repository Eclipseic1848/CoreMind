# Optional ontology example

An empty business project can install just `coremind-ontology-mcp` 0.1.1 and make an MCP query. The historical 0.1.0 acceptance and the source-based four-entry example run independently. The document assistant is a separate composition example. [Integration guide](../../../docs/modules/manage-ontology/GUIDE.en.md)

The document assistant uses [`document-review`](models/document-review/actions.json) to describe records, validate reviewer relationships, and check whether a record may be published. The same adapter loads [`equipment-maintenance`](models/equipment-maintenance/actions.json) to describe equipment, station relationships, and service restoration.

Use the [minimal deployment and recovery example](deployment/README.en.md) to run the read-only service from a project outside the checkout, verify `/health` and an object query, then rehearse a backup of both SQLite databases, isolated restoration and a switch back to the original environment.

## Repeat the 0.1.0 wheel acceptance

Copy this example's `installed_acceptance.py`, `receipt_handler.py` and `models/` to a directory outside the checkout. Activate a fresh Python 3.12 environment. Use an empty `business-test` directory to retain the assets and both databases after the check.

```sh
python -m pip install coremind-ontology-mcp==0.1.0
python -I -B -X utf8 installed_acceptance.py --project ./business-test
python -m pip uninstall -y coremind-ontology-mcp
```

To rebuild the same version, build the 0.1.0 wheel from the [2.1.0 sources](https://github.com/Eclipseic1848/CoreMind/tree/v2.1.0/components/ontology) and rerun the check.

The check uses a real Streamable HTTP client, pySHACL, and a local SQLite business transaction. It exercises read and write services, switches model versions, forces process termination after a business commit, and checks replay behavior. Success returns `businessReceipts: 2`, `unknownReplayBlocked: true` and `modelRollback: "1.0.0"`. After uninstall, verify that `business.sqlite3`, `action-receipts.sqlite3` and the model files remain in the business directory.

## Verify action receipt reconciliation

This replay script requires a historical 0.1.0 candidate wheel with the reconciliation API. Install that candidate in a dedicated Python 3.12 environment, reuse the standalone example files outside the checkout, and choose a fresh project directory for both SQLite databases.

```sh
python -I -B -X utf8 installed_acceptance.py --project ./business-reconcile --reconcile
```

The script uses a dedicated host reconciliation credential. It interrupts the gateway after a business commit and before a response arrives. After restart it verifies that a mismatched receipt still blocks a new action, then reads and submits the authoritative business receipt. MCP returns the terminal result for the original request ID, and the object query shows the resulting state. A successful report includes `completed` and `failed` in `reconciledStatuses`, `reconcileExecutorCalls` of `0`, and `published` as the resulting state after the follow-up and restart.

This request body comes from the confirmed review action in the example's business ledger. For your own model, use the [host reconciliation guide](../../../docs/modules/manage-ontology/GUIDE.en.md#host-reconciliation-and-follow-up-actions) to submit a verified business outcome.

```json
{
  "requestId": "lost",
  "resource": "urn:doc:draft",
  "previousState": "draft",
  "status": "completed",
  "state": "reviewed"
}
```

## Run the example

Use Python 3.12, uv, and the Node.js version required by the repository. Run these commands from the repository root. On Linux, use `.scratch/ontology-venv/bin/python` in place of the Windows interpreter path.

```powershell
uv venv --python 3.12 .scratch/ontology-venv
$env:COREMIND_ONTOLOGY_PYTHON = (Resolve-Path '.scratch/ontology-venv/Scripts/python.exe').Path
uv pip install --python $env:COREMIND_ONTOLOGY_PYTHON -r examples/modules/manage-ontology/requirements.txt
npm run build
& $env:COREMIND_ONTOLOGY_PYTHON -B -X utf8 -m unittest discover -s examples/modules/manage-ontology -p 'test_ontology_*.py' -v
node examples/modules/manage-ontology/acceptance.mjs
```

The runner starts a real MCP service and a deterministic model fixture on distinct loopback ports. It checks CLI/YAML, TypeScript, synchronous Python, and asynchronous Python. Enabled runs report model and mapping versions, constraint locations, and action candidates. Disabled runs still organize the documents. A model load failure yields `unavailable`. Action cases separately verify token separation, Runtime approval, and business preconditions. [Enabled configuration](coremind.yaml) · [Disabled configuration](coremind-off.yaml)

## Cross-session document assistant

```powershell
uv pip install --python $env:COREMIND_ONTOLOGY_PYTHON -r examples/modules/manage-ontology/requirements.txt -r examples/modules/manage-knowledge/requirements.txt
node examples/modules/manage-ontology/composition.mjs
```

The first session compares document versions, cites sources, and saves a summary. After the host confirms a table preference, a second session uses it and the same Skill for a different document. The ontology blocks publishing the draft. After the host updates the preference and withdraws a document version, a third session uses the list preference and retains only valid citations. The runner exercises real MCP, knowledge and memory service adapters, Skill loading, ontology, and file tools. The index, memory backend, and model use deterministic fixtures.

Bind the same endpoint to an application with reviewed local model, data, shape, mapping, and action files. The example action works on synthetic data. Production handlers own durable results through transactions, request IDs, and receipts from the business system. [Integration guide](../../../docs/modules/manage-ontology/GUIDE.en.md)

For two independent projects using real Qdrant, Hindsight and an application-selected model, see the [live document-assistant checks](LIVE-COMPOSITION.en.md).
