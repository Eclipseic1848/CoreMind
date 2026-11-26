# Deploy and restore Hindsight memory

This single-host example uses PostgreSQL 18.1, pgvector 0.8.5, Hindsight API 1.2.3, and CoreMind Memory MCP 0.1.0. The gateway serves Streamable HTTP MCP on loopback. The application receives the MCP address and its reader token. The host owns the database, receipt file, and bindings.

## Start in dependency order

Prepare Python 3.12 and PostgreSQL binaries with pgvector on PATH. Copy the requirements and binding sample into an external host directory. Install the pinned dependencies in a dedicated virtual environment. These commands use PowerShell 7.

```powershell
python -m pip install -r requirements.txt
Copy-Item bindings.example.json bindings.json
New-Item -ItemType Directory -Path state,backup
coremind-memory-mcp --version
postgres --version
```

Initialize a dedicated PostgreSQL cluster. Choose a separate password and supply it to the client tools through a PostgreSQL password file or private connection environment. Keep `state/pgdata` and reuse it on restart.

```powershell
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55434'
$env:PGUSER = 'hindsight'
initdb -D state/pgdata -U hindsight -A scram-sha-256 -W --encoding=UTF8 --no-locale
pg_ctl -D state/pgdata -l state/postgres.log -o '-h 127.0.0.1 -p 55434' -w start
pg_isready -d postgres
createdb -T template0 memory_demo
psql -X -v ON_ERROR_STOP=1 -d memory_demo -c 'CREATE EXTENSION vector;'
```

In the Hindsight terminal, provide `HINDSIGHT_API_DATABASE_URL` with the private PostgreSQL URI for this database. This example stores confirmed text chunks and uses local ONNX embeddings. Place the [pinned BGE-M3 model](../../../../components/knowledge/README.md) graph under `assets/`. Copy `tokenizer.json` to `assets/hindsight-tokenizer/` and save a UTF-8 `config.json` beside it containing `{"model_type":"xlm-roberta"}`.

```powershell
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HINDSIGHT_API_LLM_PROVIDER = 'none'
$env:HINDSIGHT_API_EMBEDDINGS_PROVIDER = 'onnx'
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH = (Resolve-Path './assets/model_quantized.onnx').Path
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH = (Resolve-Path './assets/hindsight-tokenizer').Path
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_OUTPUT_NAME = 'dense_vecs'
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS = '1024'
$env:HINDSIGHT_API_RERANKER_PROVIDER = 'rrf'
$env:HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION = 'false'
$env:HINDSIGHT_API_RETAIN_EXTRACTION_MODE = 'chunks'
hindsight-api --host 127.0.0.1 --port 8780
```

Check Hindsight readiness and start the gateway in a separate terminal. Inject three distinct complete Bearer values into the variables referenced by the bindings file. Each token value after the prefix needs at least 24 characters. Give the application only its reader token.

```powershell
$env:NO_PROXY = '127.0.0.1,localhost'
Invoke-RestMethod 'http://127.0.0.1:8780/health/ready'
coremind-memory-mcp --hindsight-url http://127.0.0.1:8780 --config bindings.json --state state/receipts.json --port 8769
```

Retain one synthetic fact as the host, then recall it with the [blank Python client](../README.en.md#recall-directly-from-an-empty-python-project). The other authorized reader should receive an empty list for the same query. Check PostgreSQL with `pg_isready`, Hindsight with `/health/ready`, and the gateway with authenticated discovery and actual recall. The gateway's `/health` covers its own process.

```powershell
$hostHeaders = @{ Authorization = $env:COREMIND_MEMORY_ADMIN_AUTHORIZATION }
$record = @{ bankId='subject-a'; documentId='summary'; expectedVersion=0; text='Use a two-column summary for conclusions and evidence.'; source='fixture:confirmed'; occurredAt='2026-01-01'; kind='fact' }
Invoke-RestMethod 'http://127.0.0.1:8769/admin/retain' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($record | ConvertTo-Json -Compress)
$control = $record.Clone()
$control.documentId = 'control'
$control.text = 'The special collection is available as read-only copies.'
Invoke-RestMethod 'http://127.0.0.1:8769/admin/retain' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($control | ConvertTo-Json -Compress)
```

## Backup, restore, and independent rollback

1. Pause application writes and stop the single-writer gateway. Take a native logical backup and copy the matching receipts and bindings. Use a new directory per backup and restrict access. Store credentials separately.

   ```powershell
   pg_dump --format=custom --no-owner --no-privileges -f backup/memory.dump -d memory_demo
   Copy-Item state/receipts.json backup/receipts-at-backup.json
   Copy-Item bindings.json backup/bindings.json
   ```

2. For the rehearsal, restart the source gateway, forget the synthetic summary through the admin endpoint, and stop the gateway again. Preserve the **latest receipts** separately before recovery. Restore to a new, empty database with the same pgvector version. Keep the original database available for independent rollback.

   ```powershell
   $forgotten = @{ bankId='subject-a'; documentId='summary' }
   Invoke-RestMethod 'http://127.0.0.1:8769/admin/forget' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($forgotten | ConvertTo-Json -Compress)
   ```

   After stopping the source gateway, copy the latest receipts and restore the database.

   ```powershell
   Copy-Item state/receipts.json backup/receipts-latest.json
   createdb -T template0 memory_demo_restored
   pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -d memory_demo_restored backup/memory.dump
   ```

3. Point Hindsight at the restored database on an isolated endpoint. Start the gateway with a working copy of the latest receipts. Check successful recall, reader isolation, and suppression of old entries. Review the latest entries in `forgetting` and `forgotten` states. Use the authorized administrator for each bank to replay `POST /admin/forget` against the restored endpoint. For example, replay the synthetic document after starting the restored gateway on 8771.

   ```powershell
   $forgotten = @{ bankId='subject-a'; documentId='summary' }
   Invoke-RestMethod 'http://127.0.0.1:8771/admin/forget' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($forgotten | ConvertTo-Json -Compress)
   ```

   Confirm that the native document and its derived memories have disappeared and that the control fact remains readable. Reconcile application writes and corrections made after the backup before reopening access. To roll back the gateway, switch the executable in its dedicated environment and preserve the latest receipts and bindings. To disable memory, remove the application binding, stop the gateway and Hindsight, then stop PostgreSQL. Retain the protected files and backups.

   If the current source build tracks experience evidence, retain the latest receipts and set `administrators: []` when rolling back to a gateway without tracking. The previous gateway serves reads during rollback. Use the tracking-aware gateway to replay deletions and review experiences. [Review and rollback procedure](../../../../docs/modules/manage-memory/SOP.en.md#verify-experience-evidence-and-review)

   ```powershell
   pg_ctl -D state/pgdata -m fast -w stop
   ```

## Rehearse automatically

Run this command from the repository root. The script creates a fresh loopback PostgreSQL cluster and starts real Hindsight and MCP processes for synthetic data. It stops those processes at exit. With a verified [2.0.0 source archive](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0), add `--previous-source` followed by the absolute path to its `examples/modules/manage-memory` directory to rehearse gateway rollback and re-upgrade.

```powershell
python -X utf8 examples/modules/manage-memory/deployment/acceptance.py --pg-bin '<PostgreSQL bin>' --model-dir '<pinned model directory>' --work-dir '<new rehearsal directory>'
```

Install a candidate wheel built from the current source and add `--experience-review` to the same command. The rehearsal confirms an experience with two sources before backup, forgets one source, and verifies that the experience stays pending after restoring the old database with the latest receipts. With `--previous-source`, it verifies that the experience stays hidden while the old gateway serves reads. After returning to the candidate gateway, the host issues a correction with current evidence and verifies the new version and review list.

The report includes versions, dump size and digest, observed startup and restore times, and checked outcomes. The native Windows exercise covers the real services and logical restore. Linux engineering CI covers the gateway lifecycle unit tests and existing composition checks. The same script can qualify native logical restore on the target Linux host. [Hindsight self-hosting](https://hindsight.vectorize.io/1.2/developer/installation) · [PostgreSQL backup and restore](https://www.postgresql.org/docs/18/backup-dump.html)
