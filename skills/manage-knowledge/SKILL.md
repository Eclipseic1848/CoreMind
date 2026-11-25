---
name: manage-knowledge
description: Implement or evaluate evidence retrieval in a CoreMind project when importing versioned documents, checking reader scope, or comparing citations across entry points.
---

# Develop a knowledge retrieval integration

1. Identify the source owner and the exact document version, passage and reader scope that support one representative answer.
2. Read the [guide](../../docs/modules/manage-knowledge/GUIDE.en.md) and reuse the [example](../../examples/modules/manage-knowledge/README.en.md) for the first query.
3. Keep the retrieval corpus separate from questions and gold citations. Test a current source, an expired edition, a restricted source and an unsupported question.
4. Compare the same citation through the configuration, TypeScript and Python paths. Inspect the text at its location in the original.
5. Follow the [SOP](../../docs/modules/manage-knowledge/SOP.en.md) to compare retrieval quality and latency with the fixed baseline. Record discrepancies with the question ID, source version and observed location.
6. For incremental updates, preserve stable document IDs and bump versions when content changes. Verify that repeated imports are unchanged, withdrawn versions leave search, and `resolve_citation` reports available, withdrawn or unknown. Run `test_knowledge_catalog.py` before changing the catalog.

For a project using only capability map 04.01–04.04, start in an empty business directory with the knowledge binding and the project's own reader scope. In 2.0.0, launch the service from the source release and pass the project manifest, model and state paths. Treat installation without the checkout as a separate delivery gate. Rehearse a stateful upgrade with a withdrawn citation and remove the binding without deleting the owner's sources or withdrawal history.

中文开发步骤与验收条件见[开发 SOP](../../docs/modules/manage-knowledge/SOP.zh-CN.md)。

Apply the host’s reader scope and as-of date to citation lookup. Test both readers across expiry and withdrawal. If saving the catalog fails, verify the live index and the restarted service still agree.
