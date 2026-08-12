---
name: extend-runtime-lifecycle
description: "Design, implement, review, or diagnose CoreMind Runtime lifecycle extensions with explicit trust, minimal capability grants, timeout isolation, and truthful terminal-state preservation."
---

# Runtime Lifecycle Extensions

1. Read the [module contract](../../docs/modules/extend-runtime-lifecycle/README.en.md) and the matching guide.
2. Confirm that configuration, a normal tool, a workflow, or event subscription cannot solve the request first.
3. Choose only the required `before-model`, `before-tool`, `after-tool`, or `run-finished` event.
4. Declare minimal file, process, network, credential, and UI capabilities; require explicit `trustedIds` and matching grants.
5. Without credential capability, verify recursive redaction of keys, authorization headers, cookies, private keys, URL secrets, and command secrets before dispatch.
6. Treat payloads as read-only. A `before-tool` handler may add denial but must never grant permission.
7. Keep handlers bounded and idempotent. Record timeout/failure receipts without changing Runtime outcome.
8. Test sync, async, timeout, failure, shared-policy denial, human denial, checkpoint order, abort, and terminal-state integrity.
9. Run every test in [module.yaml](../../docs/modules/extend-runtime-lifecycle/module.yaml) and `npm run check:modules`.
10. Stop if implementation needs provider-private objects, automatic project loading, approval mutation, or a second Runtime. Never publish implicitly.

中文执行原则：扩展只观察或附加拒绝；显式信任不是沙箱，能力声明不是自动授权。权限、Checkpoint、真实终态与审计始终由 CoreMind Runtime 持有。
