# 0.3.0-rc.1 Known Limitations

> This file records the truthful boundary of the unpublished source candidate. It does not mean release acceptance has passed.

- All 40 provider entries are configurable, but none has completed the new seven-check live revalidation. Never present configurability as certification.
- The phase-two live external same-task model evaluation has not run. Offline Coding Eval does not establish live-model quality.
- The current worktree passes the Windows P01-P19 automated matrix. Linux CI, real P20 TTY acceptance on both platforms, and the same provider's seven-check live revalidation still require the final candidate commit.
- The non-regression coverage gate passes, but repository lines, statements, and branches remain below the long-term 80% target, and selected safety-critical branches remain below 90%.
- Lifecycle extensions are controlled in-process extensions, not an operating-system sandbox. Only four events are exposed, and unknown project extensions are not loaded by default.
- Windows host-shell safety depends on the permission, workspace, and network combination. Only the built-in Linux shell uses the additional network-disabled isolation; the two are not equivalent sandboxes.
- The Python SDK uses its bundled Node Worker and still requires Node.js `>=22.19`; there is no independent pure-Python Runtime.
- Checkpoints and effect receipts provide recovery and idempotency correlation evidence, but cannot guarantee exactly-once behavior in an external business system. Uncertain effects require a pause and human verification.
- Local deterministic compaction remains the default and project Memory is not created automatically. Experimental strategies never switch themselves on.
- The candidate does not provide a complete Web development environment, hosted API, multi-tenant SaaS, official Docker image, formal macOS support, or extension marketplace.
- `0.3.0-rc.1` has not been committed, pushed, tagged, or published. Installable availability is determined by GitHub Releases, npm, and PyPI.
