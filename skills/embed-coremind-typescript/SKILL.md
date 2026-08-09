---
name: embed-coremind-typescript
description: "Embed CoreMind runtime, tools, sessions, explicit Loops, evaluation, and events in Node applications through the coremind-ai facade. Use for TypeScript or JavaScript SDK integration and diagnosis."
---

# TypeScript SDK

1. Read [the module contract](../../docs/modules/embed-coremind-typescript/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/embed-coremind-typescript/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Require a truthful effect declaration for every custom tool and exhaustively handle succeeded, failed, paused, aborted, timeout, and budget_exceeded outcomes.
6. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
7. For explicit Loops, consume ordered `loop_state` events and verify pause-resume without replaying completed steps or committed effects.
8. Run the tests listed in [module.yaml](../../docs/modules/embed-coremind-typescript/module.yaml) and `npm run check:modules`.
9. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint、Effect Receipt 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
