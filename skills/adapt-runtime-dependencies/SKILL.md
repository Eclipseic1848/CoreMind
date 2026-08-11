---
name: adapt-runtime-dependencies
description: "Align CoreMind runtime dependencies behind private adapters, verify behavioral compatibility, and provide a whole-family rollback. Use when upgrading, diagnosing, or reviewing low-level model, agent-loop, tool, usage, or Session dependencies."
---

# Runtime Dependency Adapters

1. Read the [module contract](../../docs/modules/adapt-runtime-dependencies/README.en.md) and the matching guide.
2. Freeze the reference and candidate versions, affected seams, migration scope, and rollback point.
3. Follow the [SOP](../../docs/modules/adapt-runtime-dependencies/SOP.en.md) in order.
4. Write a failing contract test before changing versions or adapters.
5. Require one exact dependency family and remove cross-version double casts.
6. Keep message, tool, usage, error, timeout, and Session conversions private to CoreMind adapters.
7. Run every test in [module.yaml](../../docs/modules/adapt-runtime-dependencies/module.yaml), then `npm run dependencies:check`, `npm run baseline:check`, and `npm run check:modules`.
8. Keep catalog availability separate from live certification. Do not send real prompts or code without authorization.
9. Roll back the whole dependency family on semantic drift; never publish implicitly.

中文执行原则：依赖必须整体锁步，先用行为测试证明兼容，再更新候选基线；参考基线、权限、终态和恢复合同不得被底层实现改写。
