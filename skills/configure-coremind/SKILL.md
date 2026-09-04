---
name: configure-coremind
description: "Describe agents, tools, a Workflow or explicit bounded Loop, budgets, permissions, and quality profiles in one validated coremind.yaml file. Use when creating, changing, reviewing, or diagnosing CoreMind configuration and schema."
---

# Configuration and Schema

1. Read [the module contract](../../docs/modules/configure-coremind/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/configure-coremind/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Select `workflow` for fixed dependencies and `loop` only for independent verification with bounded repair; reject configurations containing both.
5. For every Loop, require explicit iteration, repair, repeated-action, failure, and exhaustion bounds. Agent verification requires passIf. Development builds also support `verify.mode: host`, which forbids passIf and requires a durable host response; follow the [host integration example](../../examples/host-verification/README.en.md). Do not assume published 0.7.1 provides this new mode.
6. Require every custom tool to declare `effect.operations` and `effect.reversible`; map nested targets with `pathFields` or `urlFields`, and reject names reserved by built-in tools.
7. Add or update a failing test before implementation, then make the smallest change that passes it.
8. Inspect RunOutcome, ordered Loop states, Trace, budgets, approvals, effect receipts, and checkpoints. Treat a fluent answer without evidence as unverified.
9. Run the tests listed in [module.yaml](../../docs/modules/configure-coremind/module.yaml) and `npm run check:modules`.
10. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则、验证条件和工具副作用，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint、Effect Receipt 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
