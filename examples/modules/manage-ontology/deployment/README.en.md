# Minimal ontology deployment and recovery

This example runs one ontology MCP service. Install the published `coremind-ontology-mcp==0.1.0` in a dedicated Python 3.12 environment. The wheel pins RDFLib 7.6.0, pySHACL 0.40.2, MCP 1.30.0 and Uvicorn 0.54.0. [Public wheel](https://pypi.org/project/coremind-ontology-mcp/0.1.0/)

| Path | Owner and purpose |
| --- | --- |
| `model/` | Business Turtle, SHACL, mapping and action files. |
| `service/`, `replacement/` | Rebuildable service environments. Keep the previous one until a replacement is verified. |
| `state/action-receipts.sqlite3` | Exclusive component journal for completed and unresolved actions when writes are enabled. |
| `state/business.sqlite3` | Synthetic SQLite business transactions and authoritative receipts for this example. The business owner manages backups of a production system. |

## Run the read-only service

Run these commands with uv from the checkout root. Save the resolved paths of `$example` and `$project` for a second terminal. The Linux commands are at the end of this page.

```powershell
$example = (Resolve-Path 'examples/modules/manage-ontology').Path
$project = Join-Path ([IO.Path]::GetTempPath()) ('cm-ontology-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $project | Out-Null
Copy-Item -LiteralPath (Join-Path $example 'models/document-review') -Destination (Join-Path $project 'model') -Recurse
uv venv --python 3.12 (Join-Path $project 'service')
uv pip install --python (Join-Path $project 'service/Scripts/python.exe') coremind-ontology-mcp==0.1.0
& (Join-Path $project 'service/Scripts/coremind-ontology-mcp.exe') --version
```

Use the host's credential manager to inject the same `COREMIND_ONTOLOGY_AUTHORIZATION` into the service and reader terminals. Include `Bearer ` followed by at least 24 non-whitespace characters. Start the service in the foreground.

```powershell
& (Join-Path $project 'service/Scripts/coremind-ontology-mcp.exe') --model-dir (Join-Path $project 'model') --port 8879
```

Run this command from the reader terminal. It first checks for `ready` from the authenticated `/health` endpoint, then queries `urn:doc:guide` through Streamable HTTP MCP and prints the object, model version and digest. Accept traffic after both checks pass. Use `Ctrl+C` in the service terminal to stop it.

```powershell
& (Join-Path $project 'service/Scripts/python.exe') -I -B -X utf8 (Join-Path $example 'deployment/probe.py')
```

## Back up, restore in isolation, and switch back

1. Record the wheel, five model files and digests. For actions, supply a distinct action credential and an approved handler. The component and business service each keep receipts. Pause business writes and stop the old process before taking a coordinated backup of the model, handler, component journal and business database. Reinject credentials through the host.
2. Restore into a fresh project directory. The synthetic example copies both databases with the [SQLite backup API](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup) and checks each with `PRAGMA quick_check`. Start an isolated service and verify the model digest, known objects and business receipts. A completed request returns its saved receipt. A new request ID for an unresolved object remains blocked.
3. Before switching an application or model, repeat the same queries and receipt checks against the isolated copy. For application rollback, reopen the same latest journal using the earlier environment. Use an earlier business backup for isolated verification and use the current authoritative business system for production action state. Keep the affected object frozen while a responsible owner investigates an `unknown` result.

The commands below create synthetic data, pause the service, then back up and restore into an empty `$project/recovery-case`. The runner starts the replacement against the restored copy, then switches back to the first environment. It also uses the original lifecycle fixture to exercise model rollback `1.0.0 → 1.1.0 → 1.0.0`. Both application environments use 0.1.0 for the reinstall and rollback rehearsal. The output reports startup times, snapshot size, two business receipts, zero additional handler calls and a blocked unresolved request.

```powershell
uv venv --python 3.12 (Join-Path $project 'replacement')
uv pip install --python (Join-Path $project 'replacement/Scripts/python.exe') coremind-ontology-mcp==0.1.0
& (Join-Path $project 'service/Scripts/python.exe') -I -B -X utf8 (Join-Path $example 'deployment/restore_acceptance.py') --project (Join-Path $project 'recovery-case') --replacement-console (Join-Path $project 'replacement/Scripts/coremind-ontology-mcp.exe')
```

The rehearsal retains `original/`, `backup/` and `restored/`. Inspect both SQLite files, remove unused bindings and credentials, and retain models and receipts according to the business policy. [Development SOP](../../../../docs/modules/manage-ontology/SOP.en.md)

## Linux commands

Prepare the environment from the checkout root. Follow the same credential steps, start the foreground service in its terminal and run the probe in the reader terminal with the same variables. Stop the service after the read check and then run the recovery rehearsal.

```sh
ontology_example="$PWD/examples/modules/manage-ontology"
ontology_project="$(mktemp -d)"
cp -R "$ontology_example/models/document-review" "$ontology_project/model"
uv venv --python 3.12 "$ontology_project/service"
uv pip install --python "$ontology_project/service/bin/python" coremind-ontology-mcp==0.1.0
```

```sh
"$ontology_project/service/bin/coremind-ontology-mcp" --model-dir "$ontology_project/model" --port 8879
```

```sh
"$ontology_project/service/bin/python" -I -B -X utf8 "$ontology_example/deployment/probe.py"
uv venv --python 3.12 "$ontology_project/replacement"
uv pip install --python "$ontology_project/replacement/bin/python" coremind-ontology-mcp==0.1.0
"$ontology_project/service/bin/python" -I -B -X utf8 "$ontology_example/deployment/restore_acceptance.py" --project "$ontology_project/recovery-case" --replacement-console "$ontology_project/replacement/bin/coremind-ontology-mcp"
```
