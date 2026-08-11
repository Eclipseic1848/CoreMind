---
name: manage-context-artifacts
description: "Design, implement, diagnose, or verify stable context prefixes, deterministic compaction, truthful prompt-cache metrics, and safe large-output artifacts in a CoreMind project."
---

# Context and Artifact Governance

1. Read the [module contract](../../docs/modules/manage-context-artifacts/README.en.md) and the matching language guide.
2. Classify stable instructions, dynamic messages, complete tool output, credentials, and business data before changing code.
3. Follow the [SOP](../../docs/modules/manage-context-artifacts/SOP.en.md) in order.
4. Keep the prefix byte-stable: fixed sections, deterministic ordering, no timestamps, random values, secrets, or run-specific facts.
5. Preserve goals, constraints, approvals, changed files, tests, incomplete work, next steps, and uncertain effects in every summary.
6. Keep model-visible output bounded. Store complete output only inside the controlled workspace directory with size, hash, media type, retention, and redaction evidence.
7. Block suspected credentials from both previews and stored artifacts. Reject untrusted external output paths.
8. Record cache hits only from provider usage; an unsupported capability is unavailable and a zero hit remains zero.
9. Compare compression candidates before changing defaults. Never create project memory automatically.
10. Run the tests listed in [module.yaml](../../docs/modules/manage-context-artifacts/module.yaml), then repository module and documentation gates. Never push, tag, or publish implicitly.

中文执行原则：先区分模型可见内容和完整本地证据；稳定前缀不得包含动态值；摘要不得丢失未完成事项；凭据命中必须失败关闭。
