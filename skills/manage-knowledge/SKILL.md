---
name: manage-knowledge
description: Implement or evaluate evidence retrieval in a CoreMind project when importing versioned documents, checking reader scope, or comparing citations across entry points.
---

# Develop a knowledge retrieval integration

1. Identify the source owner and the exact document version, passage and reader scope that support one representative answer.
2. Read the [guide](../../docs/modules/manage-knowledge/GUIDE.en.md) and reuse the [example](../../examples/modules/manage-knowledge/README.en.md) for the first query.
3. Keep the retrieval corpus separate from questions and gold citations. Test a current source, an expired edition, a restricted source and an unsupported question.
4. Compare the same citation through the configuration, TypeScript and Python paths. Inspect the text at its location in the original. For PDF and DOCX on the current source revision, save `docId`, `version`, `file` and `chunkId` for lookup. Display `locator` as the page or section. Keep using line numbers for Markdown.
5. Follow the [SOP](../../docs/modules/manage-knowledge/SOP.en.md) to compare retrieval quality and latency with the fixed baseline. Record discrepancies with the question ID, source version and observed location.
6. For incremental updates, preserve stable document IDs and bump versions when content changes. Verify unchanged imports, withdrawal and restart. Round-trip the excerpts of a shared page or section and compare exact text. A legacy location with several matches should return `ambiguous` without an excerpt. Run `test_knowledge_catalog.py` before changing the catalog.
7. In an empty TypeScript project, [call the knowledge tools directly](../../examples/modules/manage-knowledge/README.en.md#query-directly-from-an-empty-typescript-project) with the standard MCP client before binding the same endpoint and reader token to the Agent. Compare the cited original across both calls. Verify a rejected credential, a restricted source, a stopped service and a run with the binding removed.

For a project using only capability map 04.01–04.04, start in an empty business directory with the knowledge binding and the project's own reader scope. Install the [0.1.0 knowledge wheel](../../components/knowledge/README.md) in a dedicated environment. Pass the project's manifest, model, reader scope and state to `coremind-knowledge-mcp`. Run the [installed lifecycle check](../../components/knowledge/tests/installed_lifecycle.py) with a real 2.0.0 source archive and the pinned BGE-M3 files. Rehearse a stateful upgrade with a withdrawn citation and remove the binding without deleting the owner's sources or withdrawal history.

Rehearse a stopped backup and restore with the [minimal deployment example](../../examples/modules/manage-knowledge/deployment/README.en.md). Run its recovery script using the installed console entry. Check authenticated readiness, source text, withdrawals and unchanged catalog bytes from a separate restore path. Record startup time and persisted size.

中文开发步骤与验收条件见[开发 SOP](../../docs/modules/manage-knowledge/SOP.zh-CN.md)。

For an opt-in persistent index, use a dedicated local `--index-dir` and keep the catalog as the source of truth. Run the [paired benchmark](../../docs/modules/manage-knowledge/SOP.en.md#persistent-index-acceptance) before changing a deployment. Verify the encoded block count, citation scope, withdrawal, and the previous catalog after an interrupted write.

Apply the host’s reader scope and as-of date to citation lookup. Test both readers across expiry and withdrawal. If saving the catalog fails, verify the live index and the restarted service still agree.
