---
name: contribute-coremind
description: "Change CoreMind source within its frozen public contracts, one-way dependencies, test-first workflow, bilingual material contract, and release authorization boundary. Use when creating, changing, reviewing, or diagnosing the source and community contribution capability in a CoreMind project."
---

# Source and Community Contribution

1. Read [the module contract](../../docs/modules/contribute-coremind/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/contribute-coremind/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Run `npm run build` and `npm run baseline:check` before changing a public seam. If the baseline is already red, stop and diagnose it first.
5. Add or update a failing test before implementation, then make the smallest change that passes it.
6. For an approved public-contract change, document migration and rollback before updating the baseline with an explicit reason. Never rewrite it merely to turn a regression green.
7. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
8. Run the tests listed in [module.yaml](../../docs/modules/contribute-coremind/module.yaml), `npm run baseline:check`, `npm run test:stability`, `npm run test:coverage`, `npm run docs:audit`, `npm run acceptance:rc`, and `npm run check:modules`. Keep Windows/Linux coverage floors current and make the generic fallback their per-metric minimum.
9. For release-facing changes, require Release Please's draft PR, synchronized npm/Python versions, P01-P19 evidence anchors, both real-pseudoterminal files, a current live-provider recheck, and one clean-tag artifact bundle.
10. Publish npm and PyPI only through protected OIDC environments, then create the GitHub Release from the exact same tarballs, wheel, source ZIP, checksums, manifest, and attestation.
11. Require external Actions to use verified full commit SHAs, let Dependabot propose upgrades, and verify the checksum manifest independently in every artifact-consuming job. Confirm pinned release tools remain available and not yanked on their official registries.
12. Stop on a security failure, an unauthorized live external benchmark, or a non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则和冻结基线，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
