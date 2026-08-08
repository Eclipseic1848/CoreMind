---
name: build-tools
description: "Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract. Use when creating, changing, reviewing, or diagnosing the tools and business capabilities capability in a CoreMind project."
---

# Tools and Business Capabilities

1. Read [the module contract](../../docs/modules/build-tools/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/build-tools/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
6. Run the tests listed in [module.yaml](../../docs/modules/build-tools/module.yaml) and `npm run check:modules`.
7. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
