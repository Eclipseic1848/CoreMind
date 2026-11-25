# Connect an empty project to Hindsight memory

The host runs Hindsight and a small MCP gateway. The business project connects with a reader token to recall confirmed facts. This example runs the service and a standard MCP client in separate directories.

## Prepare the services

1. Start the Hindsight 1.2.3 API separately on `127.0.0.1:8780`. For an isolated local instance, install `hindsight-api-slim[embedded-db,local-onnx]==1.2.3` with Python 3.12. Set `HINDSIGHT_API_DATABASE_URL=pg0://coremind-memory-demo`, `HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks`, `HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false`, `HINDSIGHT_API_LLM_TRACE_ENABLED=false` and `HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT=true`. Select a host-authorized model and embeddings suited to your language. Use `HINDSIGHT_API_RERANKER_PROVIDER=rrf` for reciprocal rank fusion. Include `127.0.0.1,localhost` in `NO_PROXY` when using a local endpoint. Run `hindsight-api --host 127.0.0.1 --port 8780`. [Upstream installation](https://hindsight.vectorize.io/developer/installation) · [Model configuration](https://hindsight.vectorize.io/developer/configuration)
2. Take `memory_server.py`, `hindsight_backend.py` and `requirements.txt` from `examples/modules/manage-memory/` in the [2.0.0 release source ZIP](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0). Put them together in a host-owned service directory. In that directory activate a dedicated Python 3.12 virtual environment and run `python -m pip install -r requirements.txt`. The gateway pins `hindsight-client==1.2.3`, `mcp==1.30.0` and `uvicorn==0.54.0`. A separate installable gateway package is planned.
3. Prepare the host binding file and receipt path outside the agent's readable workspace. The PowerShell example uses `C:/CoreMind-local/memory-host.json`. Substitute a local writable path and create its parent directory first. Other subjects and branches use separate credentials and grants for their own banks.

   ```json
   {
     "banks": {"demo-alice": {"kind": "personal"}},
     "readers": [{"tokenEnv": "COREMIND_MEMORY_AUTHORIZATION", "banks": ["demo-alice"]}],
     "administrators": [{"tokenEnv": "COREMIND_MEMORY_ADMIN_AUTHORIZATION", "banks": ["demo-alice"]}]
   }
   ```

4. Set two different tokens in the service terminal. Each token must have at least 24 characters. If the Hindsight service requires an API key, inject it separately through `COREMIND_HINDSIGHT_API_KEY`. Keep the service terminal running.

   ```powershell
   $env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host 'Recall token' -MaskInput)
   $env:COREMIND_MEMORY_ADMIN_AUTHORIZATION = 'Bearer ' + (Read-Host 'Host administration token' -MaskInput)
   python -B -X utf8 ./memory_server.py --hindsight-url http://127.0.0.1:8780 --config 'C:/CoreMind-local/memory-host.json' --state 'C:/CoreMind-local/memory-receipts.json' --port 8769
   ```

   The gateway listens on `127.0.0.1:8769`. Keep its bindings and receipts outside the business workspace. One running gateway owns each receipt file.

## Check retention, recall, correction, and forgetting

In a separate host administration terminal, inject the administrator token and save a confirmed preference. Use a new document ID in each independent demo. On retry, keep the ID, expected revision, content and source.

```powershell
$env:COREMIND_MEMORY_ADMIN_AUTHORIZATION = 'Bearer ' + (Read-Host 'Host administration token' -MaskInput)
$memoryUrl = 'http://127.0.0.1:8769/admin'
$memoryHeaders = @{ Authorization = $env:COREMIND_MEMORY_ADMIN_AUTHORIZATION }
$memory = @{
    bankId = 'demo-alice'
    documentId = 'summary-format-' + [guid]::NewGuid().ToString('N')
    expectedVersion = 0
    text = 'Prefer tables for document summaries.'
    source = 'demo:host-confirmed-preference'
    occurredAt = [datetime]::UtcNow.ToString('yyyy-MM-dd')
    kind = 'fact'
}
$saveBody = $memory | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$memoryUrl/retain" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body $saveBody
```

Expect `active` and version `1`. In a new business directory with a separate Python 3.12 virtual environment, install `python -m pip install mcp==1.30.0`. Save this client as UTF-8 `read_memory.py`.

```python
import asyncio
import json
import os
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async def main():
    headers = {"Authorization": os.environ["COREMIND_MEMORY_AUTHORIZATION"]}
    async with httpx.AsyncClient(headers=headers) as http:
        async with streamable_http_client("http://127.0.0.1:8769/mcp", http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                assert [t.name for t in (await session.list_tools()).tools] == ["recall_memory"]
                reply = await session.call_tool("recall_memory", {"query": sys.argv[1]})
                assert not reply.isError
                print(json.dumps(json.loads(reply.content[0].text), ensure_ascii=False))

asyncio.run(main())
```

In the business terminal set only the reader token, run the query, and check `demo-alice`, the document ID, version `1`, text and source. A valid reader bound only to a different empty bank gets an empty `memories` list. An invalid credential receives HTTP 401.

```powershell
$env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host 'Recall token' -MaskInput)
python -X utf8 read_memory.py 'Which format should I use for document summaries?'
```

Back in the host administration terminal, correct version 1 to version 2.

```powershell
$memory.expectedVersion = 1
$memory.text = 'Prefer lists for document summaries.'
$memory.source = 'demo:host-confirmed-correction'
Invoke-RestMethod -Method Post -Uri "$memoryUrl/correct" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body ($memory | ConvertTo-Json -Compress)
```

Repeat the same query in the reader terminal. Expect only version `2` with the corrected preference for lists.

To inspect reflective output and its evidence, call `/admin/reflect` with `bankId` and `query`. The host reviews the response before confirming it as a separate write. To forget the preference, pass the original bank and document ID.

```powershell
$forgetBody = @{ bankId = $memory.bankId; documentId = $memory.documentId } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$memoryUrl/forget" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body $forgetBody
```

Expect `forgotten`. To remove all CoreMind-managed documents in a bank, send its `bankId` to `/admin/forget-bank`. Restart the service and verify that a new session cannot recall the forgotten content. To restore an older Hindsight backup, retain the current host receipts and replay the corresponding deletions before serving requests. Session history follows its own retention and restore rules.

## Four CoreMind entry points

For real application configuration, see the [integration guide](../../../docs/modules/manage-memory/GUIDE.en.md). To reproduce the repository’s four-entry check, build the checkout with `npm ci` and `npm run build`, then install `python -m pip install -e ./python` in the acceptance environment. With the gateway running, after saving the table preference and before correcting or forgetting it, run `node examples/modules/manage-memory/acceptance.mjs "Which format should I use for document summaries?" "Prefer tables for document summaries."` from the root. The driver uses a deterministic model on port 8770, the checkout CLI and source Worker, and the interpreter selected by `COREMIND_MEMORY_PYTHON`. For an installed-consumer check, use published CLI/SDK packages and the default wheel Worker. Assess live model quality separately.

Return to the [integration guide](../../../docs/modules/manage-memory/GUIDE.en.md). See the [development SOP](../../../docs/modules/manage-memory/SOP.en.md) for individual acceptance cases.
