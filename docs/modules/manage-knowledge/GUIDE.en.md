# Connect a citable knowledge source

The host selects the scope of material a reader may access and starts the knowledge service on the loopback address `127.0.0.1`. The example exposes a read-only `search_knowledge` tool over CoreMind's existing Streamable HTTP MCP interface. Its only query parameter is `query`. The host controls the read scope. TypeScript, Python and the CLI use the same project configuration and service.

## First query

Follow the [example](../../../examples/modules/manage-knowledge/README.en.md) to prepare the environment and run the three entry points. As a public reader, ask “ST-17 拼接地图现在由哪一个窗口受理？” (Which desk currently accepts ST-17 maps?). Find 榆木台 and open line 6 of the [second edition](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v2.md). Line 6 of the [first edition](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v1.md) lists the same item at a different desk, 榛果台. Checking the line number alone would accept that stale result.

Read the supporting excerpt before using a retrieved item to answer. If the visible sources do not support a claim, report insufficient evidence. Use the same questions, permissions and versions from the [development SOP](SOP.en.md) when comparing retrieval components.

For a Markdown table row, both `search_knowledge` and `resolve_citation` include a `tableHeader` from the same document version. In the example above, line 6 keeps the original item, desk and packaging values. The header is on line 4 (`tableHeader[0].line`), with the original column labels in `tableHeader[0].text`. Interpret each value using those labels and cite the data row. Ordinary paragraphs, header rows and example tables inside code blocks keep their existing citation format.

## Incremental imports and withdrawal

Pass `--state` to keep a state file with each version's text, scope and withdrawal status. Restarting with the same version and content does not write a duplicate. Changed content for an existing version fails and requires a version bump. `--withdraw DOC:VERSION` removes that version from search immediately, while `resolve_citation` tells an old run whether its citation is available, withdrawn or unknown. A failed rebuild keeps the previous index and state file.

Historical citations use the service’s reader scope and the manifest’s as-of date. Validity starts on the first date and ends before the expiry date. Out-of-scope or out-of-period citations return `unknown`. Readers can see an excerpt or a withdrawal status only within that boundary.

Re-import the original manifest and Markdown files to upgrade a saved state. The service checks the existing text, positions, version and visibility before adding header context. It preserves withdrawals and treats subsequent identical imports as unchanged.
