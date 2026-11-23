# Remember a confirmed preference in a document assistant

This example uses Hindsight 1.2.3 to retain a confirmed memory such as “prefer tables for document summaries.” The host manages authorization, confirmation, correction, and forgetting. The CoreMind agent uses `recall_memory(query)` to search currently visible memories.

## Prepare the services

1. Start Hindsight 1.2.3 and bind its API to `127.0.0.1:8780` on the local machine. Configure the model and persistent storage. See the [Hindsight installation guide](https://hindsight.vectorize.io/developer/installation) and [model guide](https://hindsight.vectorize.io/developer/models).
2. From the repository root, install the dependencies in a dedicated Python environment with `python -m pip install -r examples/modules/manage-memory/requirements.txt`. Run `npm run build` to build the CLI, TypeScript SDK, and Python Worker. Run `python -m pip install -e ./python` in the Python environment used for verification.
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
   python -B -X utf8 examples/modules/manage-memory/memory_server.py --hindsight-url http://127.0.0.1:8780 --config 'C:/CoreMind-local/memory-host.json' --state 'C:/CoreMind-local/memory-receipts.json'
   ```

   The CoreMind recall and administration service listens on `127.0.0.1:8769`. The [sample configuration](coremind.yaml) grants the agent the recall tool.

## Check retention, recall, correction, and forgetting

Set the same two demo tokens in a second PowerShell terminal, then save a confirmed preference. Use a new memory ID for each independent demo. On retry, preserve the document ID, expected revision, content, and source.

```powershell
$env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host 'Recall token' -MaskInput)
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

Expect `active` and revision `1`. Run the four entry points. The script starts and stops a local model fixture on `127.0.0.1:8770`. Set `COREMIND_MEMORY_PYTHON` to the absolute path to the Python interpreter with `coremind-ai` installed if it is different from `python` on the path.

```powershell
node examples/modules/manage-memory/acceptance.mjs 'Which format should I use for document summaries?' 'Prefer tables for document summaries.'
```

All four entry points should report the same bank, document ID, revision, content, and source. Use a credential for another subject or a branch without a grant and expect no match.

Check the current revision before correcting it. The example updates revision 1 to revision 2 and repeats the check.

```powershell
$memory.expectedVersion = 1
$memory.text = 'Prefer lists for document summaries.'
$memory.source = 'demo:host-confirmed-correction'
Invoke-RestMethod -Method Post -Uri "$memoryUrl/correct" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body ($memory | ConvertTo-Json -Compress)
node examples/modules/manage-memory/acceptance.mjs 'Which format should I use for document summaries?' 'Prefer lists for document summaries.'
```

To inspect reflective output and its evidence, call `/admin/reflect` with `bankId` and `query`. The host reviews the response before confirming it as a separate write. To forget the preference, pass the original bank and document ID.

```powershell
$forgetBody = @{ bankId = $memory.bankId; documentId = $memory.documentId } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$memoryUrl/forget" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body $forgetBody
```

Expect `forgotten`. To remove all CoreMind-managed documents in a bank, send its `bankId` to `/admin/forget-bank`. Restart the service and verify that a new session cannot recall the forgotten content. To restore an older Hindsight backup, retain the current host receipts and replay the corresponding deletions before serving requests. Session history follows its own retention and restore rules.

Live model quality and cleanup of Hindsight's native observations require separate tests. The model fixture checks how each CoreMind entry point interacts with the recall tool.

Return to the [integration guide](../../../docs/modules/manage-memory/GUIDE.en.md). See the [development SOP](../../../docs/modules/manage-memory/SOP.en.md) for individual acceptance cases.
