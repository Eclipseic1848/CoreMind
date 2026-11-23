---
name: manage-memory
description: Build and verify CoreMind long-term memory integrations when adding scoped recall, host-confirmed facts, reflection candidates, correction, expiry, or forgetting.
---

# Develop a long-term memory integration

1. Read the [integration guide](../../docs/modules/manage-memory/GUIDE.en.md). Identify the host that authenticates the caller, the project, subject, agent and branch scope, and the role that can confirm changes.
2. Keep candidate extraction and confirmation separate. Give the agent only the needed read tool. Use a source reference and preserve the boundary between memory and session history.
3. Verify recall with a confirmed preference and a new authorized session. Repeat with a different subject and a branch without a grant.
4. Follow the [development SOP](../../docs/modules/manage-memory/SOP.en.md) for event replay, stale correction, expiry, forgetting after restart, and four-entry-point parity. Count incorrect extraction separately from incorrect use.
5. Check the source scope, revision, and observable outcome for every positive and negative case.

中文步骤与验收条件见[开发 SOP](../../docs/modules/manage-memory/SOP.zh-CN.md)。
