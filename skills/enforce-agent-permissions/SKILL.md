---
name: enforce-agent-permissions
description: "Enforce ask, assisted, and full approval modes while distinguishing path-aware file tools, the Linux bash OS sandbox, and Windows shell risk boundaries. Use when creating, changing, reviewing, or diagnosing the permissions and security capability in a CoreMind project."
---

# Permissions and Security

1. Read [the module contract](../../docs/modules/enforce-agent-permissions/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/enforce-agent-permissions/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Resolve the structured ToolEffect before approval. Test nested paths, URLs, absolute paths, drives, UNC paths, and directory links, and reject undeclared effects when restrictions cannot be proven.
6. On Windows, fail closed unless full mode, open workspace access, and allowed network are all explicit. Treat Git Bash as interpreter compatibility rather than isolation, and prefer path-aware tools or an isolated Linux environment when restrictions are required.
7. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
8. When testing ask mode, make a deterministic provider repeat the same tool request. Deny the first approval and require one model request, one approval, zero side effects, and a paused outcome. In a sequential workflow, require that the denied step saves no output and no later step starts; a human denial must never consume later model turns or workflow steps.
9. Run the tests listed in [module.yaml](../../docs/modules/enforce-agent-permissions/module.yaml) and `npm run check:modules`.
10. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；人工拒绝后必须阻断本批次尚未审批的后续工具，并在本批结果归并后暂停，不得继续消耗模型轮次或工作流步骤；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
