---
name: embed-coremind-python
description: "Drive the same Node runtime and explicit Loop over stdio JSON-RPC from Python, using v1 callable tools or v2 declarative tools and host verification. Use for Python SDK, protocol parity, tool bridge, or recovery work."
---

# Python SDK and Tool Bridge

1. Read [the module contract](../../docs/modules/embed-coremind-python/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/embed-coremind-python/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. In default Protocol v1, require a truthful effect declaration for every Python callable and verify all six terminal states and approval events. Protocol v2 does not execute Python callables: use `register_tool_definition()` and `submit_tool_result()`, then read the final outcome through `query(run_id)`.
6. Inject initialization or registration failure and verify the partially started worker is closed before the exception escapes.
7. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
8. Compare explicit Loop state order and pause-resume with TypeScript; never replay completed steps or committed effects. For v2 host verification, bind the durable decision to the request identity and candidate hash; `accepted` is not `applied` or final success.
9. Verify v1 snapshot contracts against TypeScript, including operation, outcome, metrics, trace, checkpoints, artifacts, and extension receipts; reject drift with `invalid_run_snapshot`. In v2, `run` returns a RunHandle first; inspect the later Projection with `query(run_id)`.
10. Confirm packaged Python uses the bundled Node Worker and never introduces a separate Python Runtime or Loop.
11. Run the tests listed in [module.yaml](../../docs/modules/embed-coremind-python/module.yaml) and `npm run check:modules`.
12. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint、Effect Receipt 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
