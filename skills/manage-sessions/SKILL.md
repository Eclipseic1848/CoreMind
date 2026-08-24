---
name: manage-sessions
description: "Persist multi-turn messages, fail clearly on corrupt recovery, and protect context deterministically before provider calls. Use when creating, changing, reviewing, or diagnosing the sessions and context capability in a CoreMind project."
---

# Sessions and Context

1. Read [the module contract](../../docs/modules/manage-sessions/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/manage-sessions/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
6. Resolve the context window and output limit for the actual provider/model route. Budget the request's exact output reserve, stable prefix, tool schemas, structured output, multimodal occupancy, protocol overhead, and safety margin; fail closed before the provider call on missing or conflicting evidence.
7. Inject legacy compaction failure and require `context_compaction_failed`. For the model-aware lifecycle, inject sessionless compaction, output-limit conflict, artifact drift, corrupt lineage, model switching, and provider overflow; require `context_lifecycle_failed`, preserved messages, and the expected zero-or-one provider-call count.
8. Verify every lifecycle compaction persists a session summary, retains the six mandatory task sections plus the previous complete turn and active user message, links a valid ledger parent, and rebuilds from canonical session messages at the depth limit.
9. Run the tests listed in [module.yaml](../../docs/modules/manage-sessions/module.yaml) and `npm run check:modules`.
10. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；需要压缩的长任务必须有可持久化 Session，不能只保留内存摘要；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
