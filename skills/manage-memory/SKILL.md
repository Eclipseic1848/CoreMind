---
name: manage-memory
description: Build and verify CoreMind long-term memory integrations when adding scoped recall, host-confirmed facts, reflection candidates, experience evidence and review, correction, expiry, or forgetting.
---

# Develop a long-term memory integration

1. Start with a blank business project and a separate host-owned service directory. Build the 0.1.0 wheel from `components/memory`, install it in the host environment and verify `coremind-memory-mcp --version`. Reuse the 2.0.0 receipt file and bank-binding contract when upgrading. Follow the [integration guide](../../docs/modules/manage-memory/GUIDE.en.md) to bind the reader to a project, subject, agent and branch.
2. Expose only `recall_memory(query)` to the agent. Inject its reader token in the business project. Keep administration credentials, Hindsight credentials, the database and the single-writer receipt file on the host. Require host confirmation before retaining a candidate and keep its source reference.
3. Verify recall with a confirmed preference and a new authorized session. Repeat with a different subject and a branch without a grant.
4. Follow the [development SOP](../../docs/modules/manage-memory/SOP.en.md) for event replay, stale correction, expiry, forgetting after restart, and four-entry-point parity. Rerun the [offline outcome regression](../../examples/modules/manage-memory/README.en.md#offline-outcome-regression) and keep per-case candidate, source revision, and adoption receipts. Count incorrect or missed candidates separately from incorrect or missed adoption.
   For a tracked experience, have the host confirm the same-bank source IDs and revisions. Review the `/admin/review-status` list after correcting or forgetting evidence. When the host has verified the new evidence, send `/admin/correct` with the pending experience's current version and valid evidence. Use the [automated review example](../../examples/modules/manage-memory/README.en.md#experience-evidence-and-review) to check suppression and replay.
5. Check the MCP tool list and a host retain followed by a real recall in a fresh client. Verify that published SDKs resolve from the consumer and that Python starts its wheel-bundled Worker. Before an upgrade, restore the database and latest receipts in isolation and replay forgotten IDs. Record source scope, revision and observed outcome for each case.
6. [Call `recall_memory` directly](../../examples/modules/manage-memory/README.en.md#recall-directly-from-an-empty-python-project) from an empty Python project with a reader token, then bind the same endpoint to the Agent. Compare bank, revision, source and text. Verify an invalid token, a reader whose own bank is empty, a stopped gateway and an Agent run with the binding removed.

中文步骤与验收条件见[开发 SOP](../../docs/modules/manage-memory/SOP.zh-CN.md)。

For a new host, follow the [standalone deployment rehearsal](../../examples/modules/manage-memory/deployment/README.en.md). Keep PostgreSQL data and the latest gateway receipts separate. Before reopening a restored endpoint, check database and Hindsight readiness, authenticate to MCP, prove an actual recall, and replay forgotten IDs with the bank's administrator.
