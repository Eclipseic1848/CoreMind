---
name: build-tools
description: "Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract. Use when creating, changing, reviewing, or diagnosing the tools and business capabilities capability in a CoreMind project."
---

# Tools and Business Capabilities

1. Read [the module contract](../../docs/modules/build-tools/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/build-tools/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Require every custom tool to declare `effect.operations` and `effect.reversible`, reject built-in-name collisions, and test nested path and URL arguments against workspace and network policy before trusting the tool.
6. Run subprocesses with a command plus argument array, explicit timeout/output limits, cancellation, and the smallest environment. Treat a caller-supplied `env` as authoritative; never reintroduce host secrets through merging or let the execution context replace it.
7. Keep Git adapters read-only and bounded. Reject arbitrary subcommands, mutations, workspace escape, and unsafe links. Bound diff input, output, and complexity.
8. For local MCP, select exact per-agent raw tools, require authorized trusted-host execution, and keep connection/list/business calls inside the existing Run Harness. Use only explicit environment references, preserve full schema, deny Child inheritance, close owned processes before quiescence, and never replay unknown effects. Static doctor must not start services.
9. For HTTP MCP, fix the endpoint without userinfo/query/fragment and resolve complete Header values from environment or SecretRef references. Default HTTPS permits verified public addresses; a nonempty exact-IP allowlist constrains every resolved address, and plain HTTP additionally requires a listed loopback IP literal. Preserve DNS-to-socket pinning and TLS checks; reject redirects and environment proxies. Keep existing network approval and truthful business effects; never downgrade external authority. Missing credentials and 401/403 fail without identity fallback, OAuth, or refresh.
10. Grant HTTP resources only through exact per-agent `mcpResources` URI sets; missing/empty sets inherit nothing, and stdio resources are unsupported. Keep list/templates/read lazy, prevent template or response-URI scope expansion, and never dereference resource links or host files. Preserve no-HTTP-before-first-model behavior for resource-only agents, independent request cancellation, bounded bodies/directories/GET recovery, and no business POST replay. Close local bodies/sockets/the dispatcher before quiescence without remote DELETE; remote sessions rely on service leases. Child Runs receive no MCP resources or credentials. Keep secrets out of prompts, Facts, exceptions, Artifacts, and Worker JSON.
11. Inspect RunOutcome, Trace, budgets, approvals, checkpoints, and diffs. Treat a fluent answer without evidence as unverified.
12. Run the tests listed in [module.yaml](../../docs/modules/build-tools/module.yaml) and `npm run check:modules`. Keep TypeScript, CLI, Python, installed artifacts, supported platforms, and real external interoperability evidence distinct; a listed test is not a passing result.
13. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
