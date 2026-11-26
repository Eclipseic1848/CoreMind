# Connect a citable knowledge source

The host selects the scope of material a reader may access and starts the knowledge service on the loopback address `127.0.0.1`. The example exposes a read-only `search_knowledge` tool over CoreMind's existing Streamable HTTP MCP interface. Its only query parameter is `query`. The host controls the read scope. TypeScript, Python and the CLI use the same project configuration and service.

## Connect only knowledge from an empty project

Use a dedicated Python 3.12 environment and a BGE-M3 model directory. Place the [knowledge-only example](../../../components/knowledge/README.md) manifest, its adjacent `sources/` and `query.py` in the empty business directory or provide your own documents. Set the full `COREMIND_KNOWLEDGE_AUTHORIZATION` value. Install from PyPI and start the service in the project directory with `MODEL_DIR` pointing to the verified model.

```sh
python -m pip install coremind-knowledge-mcp==0.1.0
coremind-knowledge-mcp --version
coremind-knowledge-mcp --manifest ./manifest.json --model-dir "$MODEL_DIR" --state ./state/catalog.json --scope records
```

The [component README](../../../components/knowledge/README.md) gives the commands to build the same version from source.

Connect any Streamable HTTP MCP client to `http://127.0.0.1:8767/mcp` with the full credential in the `Authorization` header. Find `search_knowledge` and `resolve_citation` in `tools/list`, then search and look up a citation. In a CoreMind project, copy the `mcp.servers.knowledge` binding and the required Agent tool declarations from the [example configuration](../../../examples/modules/manage-knowledge/coremind.yaml) into your own configuration and use your own model. No document-assistant template or other domain service is required.

Copy the [empty TypeScript project example](../../../examples/modules/manage-knowledge/README.en.md#query-directly-from-an-empty-typescript-project). Search and resolve citations from application code, then run a CoreMind Agent against the same endpoint with the same reader token. Direct calls require the knowledge reader token. Configure a separate model for the Agent.

## First query

Follow the [example](../../../examples/modules/manage-knowledge/README.en.md) to prepare the environment and run the three entry points. As a public reader, ask “ST-17 拼接地图现在由哪一个窗口受理？” (Which desk currently accepts ST-17 maps?). Find 榆木台 and open line 6 of the [second edition](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v2.md). Line 6 of the [first edition](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v1.md) lists the same item at a different desk, 榛果台. Checking the line number alone would accept that stale result.

Read the supporting excerpt before using a retrieved item to answer. If the visible sources do not support a claim, report insufficient evidence. Use the same questions, permissions and versions from the [development SOP](SOP.en.md) when comparing retrieval components.

For a Markdown table row, both `search_knowledge` and `resolve_citation` include a `tableHeader` from the same document version. In the example above, line 6 keeps the original item, desk and packaging values. The header is on line 4 (`tableHeader[0].line`), with the original column labels in `tableHeader[0].text`. Interpret each value using those labels and cite the data row. Ordinary paragraphs, header rows and example tables inside code blocks keep their existing citation format.

The current source returns a positive integer `chunkId` for PDF and DOCX excerpts, numbered from 1 within each document version. Display the page or section from `locator`. For exact lookup, pass the returned `docId`, `version`, `file` and `chunkId` to `resolve_citation`. If you supply extra location fields, they must all match. Markdown citations use the line number. Compare the search and lookup text using the [excerpt lookup example](../../../examples/modules/manage-knowledge/README.en.md#resolve-excerpts-on-the-same-page-or-in-the-same-section).

## Incremental imports and withdrawal

Pass `--state` to keep a state file with each version's text, scope and withdrawal status. Restarting with the same version and content does not write a duplicate. Changed content for an existing version fails and requires a version bump. `--withdraw DOC:VERSION` removes that version from search immediately. A failed rebuild keeps the previous index and state file.

Historical citations use the service’s reader scope and the manifest’s as-of date. Validity starts on the first date and ends before the expiry date. Out-of-scope or out-of-period citations return `unknown`. Readers can see an excerpt or a withdrawal status only within that boundary.

The current source resolves old page or section citations with a single match. Multiple matches return `ambiguous`, and no matches return `missing`. Neither result includes an excerpt. A visible withdrawn version returns `withdrawn` before excerpt lookup.

Re-import the original manifest and Markdown files to upgrade a saved state. The service checks the existing text, positions, version and visibility before adding header context. It preserves withdrawals and treats subsequent identical imports as unchanged.

## Upgrade and removal

Use the [minimal deployment and recovery example](../../../examples/modules/manage-knowledge/deployment/README.en.md) to rehearse a stopped backup and restore outside the checkout. Keep the manifest, originals and catalog together. Starting the restored copy rebuilds the in-memory index.

Stop the old service before upgrading and save the originals, manifest, model revision and state file. Start the target version against a copy. Verify current citations, idempotent imports and withdrawn citations before switching the client. A rollback uses the previous service environment and checked state while preserving withdrawals made since the upgrade. To disconnect a project, remove its MCP tools, server binding and reader credential. Stop the process and remove its Python environment if the service belongs exclusively to that project. Source documents, manifests, withdrawal records and shared models stay under their owners' retention policies.

The service derives `chunkId` from the stored excerpt order for each version, so the catalog can be used for upgrades and rollbacks. Public version 0.1.0 understands the legacy locations. After rolling back to 0.1.0, check a shared page or section in the original document. Exact lookup by `chunkId` requires a service that supports it.
