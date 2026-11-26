# Minimal knowledge deployment and recovery

This example uses Python 3.12, the published `coremind-knowledge-mcp==0.1.0` wheel and local BGE-M3 files. The service listens on loopback and uses in-process Qdrant. A knowledge-only setup needs the model files, business sources and catalog. It can run independently of other components and model API credentials.

## Start and verify

Create a deployment directory outside the repository. In its `business/` subdirectory, place the [sample manifest](../../../../components/knowledge/example/manifest.json), [`sources/desk.md`](../../../../components/knowledge/example/sources/desk.md) and [query script](../../../../components/knowledge/example/query.py) at the same relative paths. Install the pinned wheel in a dedicated Python virtual environment. Keep the virtual environment and BGE-M3 files outside `business/`. See the [pinned BGE-M3 material](../README.en.md#prepare-the-retrieval-model-and-run-the-fixed-dataset) for the model revision and verification.

Set `COREMIND_KNOWLEDGE_AUTHORIZATION` in both terminals to `Bearer ` followed by a random read token of at least 24 characters. The host chooses the reader's scope. In `business/`, start the service with the absolute path to the local model files.

```sh
python -m pip install coremind-knowledge-mcp==0.1.0
coremind-knowledge-mcp --version
coremind-knowledge-mcp --manifest manifest.json --model-dir "/absolute/model-dir" --state state/catalog.json --scope records
```

In the second terminal, check authenticated readiness and then verify an actual citation.

```sh
python -X utf8 -c "import json,os,urllib.request as u; r=u.Request('http://127.0.0.1:8767/health',headers={'Authorization':os.environ['COREMIND_KNOWLEDGE_AUTHORIZATION']}); print(json.load(u.build_opener(u.ProxyHandler({})).open(r,timeout=5)))"
python -X utf8 query.py "松纹卡"
```

Health should return `ready`. The search and lookup should agree on line 3 of `desk.md`, the 银杏台 value and the original header on line 1. A different reader scope uses its own endpoint, token and state path.

## Offline backup, restore and rollback

1. Press Ctrl+C in the service terminal and confirm that it has exited. Record the wheel version and digest, BGE-M3 revision, port and reader scope. Back up `manifest.json`, `sources/` and `state/catalog.json`. Keep credentials under host control.
2. Run these copy commands from the parent of `business/`. Use a new restore directory. Run the start command again from `restored/` with the original model, port and scope.

   ```sh
   python -X utf8 -c "from shutil import copytree; copytree('business','backups/knowledge-before-change')"
   python -X utf8 -c "from shutil import copytree; copytree('backups/knowledge-before-change','restored')"
   ```

3. Compare health, source text, version, location and withdrawal status before switching the application's connection. Qdrant rebuilds the index at startup from the durable originals, manifest and catalog. When restoring an older snapshot, reconcile and reapply later withdrawals before enabling reads.
4. For an upgrade, install the new wheel in a separate environment and test against a state copy. For a rollback, use the previous environment and a verified copy that accounts for withdrawals made during the upgrade. Verify it before reconnecting the application. To disable the component, remove the MCP binding, revoke its token and stop the process.

## Automated acceptance

Run from the checkout with Python 3.12. Pass the installed console entry at `Scripts/coremind-knowledge-mcp.exe` on Windows or `bin/coremind-knowledge-mcp` on Linux. The script starts the real service three times with two synthetic documents in a temporary directory and restores to a new path. It checks HTTP 401, source lookup, withdrawal without source text and byte-identical restore. Its report includes startup, search and copy times plus backup and model sizes.

```sh
python -B -X utf8 examples/modules/manage-knowledge/deployment/verify.py --console "/absolute/coremind-knowledge-mcp" --model-dir "/absolute/model-dir"
```

Use the [installed lifecycle test](../../../../components/knowledge/tests/installed_lifecycle.py) to rehearse migration and rollback between the 2.0.0 source service and the installed knowledge wheel. With a wheel built from the current source, add `--persistent` to verify persistent mode following the [knowledge SOP](../../../../docs/modules/manage-knowledge/SOP.en.md#persistent-index-acceptance).
