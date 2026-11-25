# Optional ontology example

An empty business project can install just the `0.1.0` ontology wheel supplied for the 2.1.0 candidate and make an MCP query. The standalone acceptance and the source-based four-entry example run independently. The document assistant is a separate composition example. [Integration guide](../../../docs/modules/manage-ontology/GUIDE.en.md)

The document assistant uses [`document-review`](models/document-review/actions.json) to describe records, validate reviewer relationships, and check whether a record may be published. The same adapter loads [`equipment-maintenance`](models/equipment-maintenance/actions.json) to describe equipment, station relationships, and service restoration.

## Accept the installed wheel

From the repository root, build with `python -m pip wheel --no-deps --wheel-dir .scratch/ontology-wheels ./components/ontology`. Copy the wheel and this example’s `installed_acceptance.py`, `receipt_handler.py` and `models/` to an external directory. Activate a fresh Python 3.12 environment. Use an empty `business-test` directory to retain the assets and both databases after the check.

```sh
python -m pip install ./coremind_ontology_mcp-0.1.0-py3-none-any.whl
python -I -B -X utf8 installed_acceptance.py --project ./business-test
python -m pip uninstall -y coremind-ontology-mcp
```

The check uses a real Streamable HTTP client, pySHACL, and a local SQLite business transaction. It exercises read and write services, switches model versions, forces process termination after a business commit, and checks replay behavior. Success returns `businessReceipts: 2`, `unknownReplayBlocked: true` and `modelRollback: "1.0.0"`. After uninstall, verify that `business.sqlite3`, `action-receipts.sqlite3` and the model files remain in the business directory.

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
