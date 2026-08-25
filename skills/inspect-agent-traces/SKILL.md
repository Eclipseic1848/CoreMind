---
name: inspect-agent-traces
description: "Preserve reviewable evidence through events carrying runId, eventId, sequence, and timestamp plus append-only RunState, and derive safe resume plans. Use when creating, changing, reviewing, or diagnosing the trace, runstate, and debugging capability in a CoreMind project."
---

# Trace, RunState, and Debugging

1. Read [the module contract](../../docs/modules/inspect-agent-traces/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/inspect-agent-traces/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
6. For explicit Loops, inspect persisted state order, the latest versioned snapshot, and not_started/started/committed/unknown effect receipts before approving resume.
7. Verify that credential fields, bodies, command secrets, and URL secrets are redacted before persistence without hiding normal test commands needed by graders.
8. For ReplayKit, use fixed canonical Facts and the actual Provider Working Set fixture. Require persisted request fingerprints to match and never call a Provider or tool during replay.
9. Keep local observation independent from Telemetry egress. Enabled egress requires persisted configuration, same-run scope-fingerprinted consent, and an exact-origin receipt produced by a trusted Adapter. Receipt construction alone is not DNS/TLS proof; `handed_off` is not receiver delivery.
10. Run the tests listed in [module.yaml](../../docs/modules/inspect-agent-traces/module.yaml) and `npm run check:modules`.
11. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint、Effect Receipt 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。Replay 必须使用固定 Facts 与实际 Working Set；Telemetry 收据不能冒充真实 DNS/TLS 或接收端交付证据。
