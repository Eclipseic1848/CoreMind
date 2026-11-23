# Connect a citable knowledge source

The host selects the scope of material a reader may access and starts the knowledge service on the loopback address `127.0.0.1`. The example exposes a read-only `search_knowledge` tool over CoreMind's existing Streamable HTTP MCP interface. Its only query parameter is `query`. The host controls the read scope. TypeScript, Python and the CLI use the same project configuration and service.

## First query

Follow the [example](../../../examples/modules/manage-knowledge/README.en.md) to prepare the environment and run the three entry points. As a public reader, ask “ST-17 拼接地图现在由哪一个窗口受理？” (Which desk currently accepts ST-17 maps?). Find 榆木台 and open line 6 of the [second edition](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v2.md). Line 6 of the [first edition](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v1.md) lists the same item at a different desk, 榛果台. Checking the line number alone would accept that stale result.

Read the supporting excerpt before using a retrieved item to answer. If the visible sources do not support a claim, report insufficient evidence. Use the same questions, permissions and versions from the [development SOP](SOP.en.md) when comparing retrieval components.
