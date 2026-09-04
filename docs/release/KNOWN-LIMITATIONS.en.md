# 0.7.1 Known Limitations

> This file records the capability boundary of the stable `0.7.1` release line. The live GitHub Release, npm, and PyPI pages are the only authority for installable availability.

- All 40 Provider entries are configurable, but a static catalog entry is not live certification. The [approved simplified publication](README.en.md) of `0.7.1` reuses the successful both-platform offline candidate. The Provider job failed during npm setup before any model request; strict certification remains incomplete. Older certification evidence does not establish a pass for this version.
- The phase-two live external same-task model evaluation has not run. Offline Coding Eval does not establish live-model quality.
- `0.7.1` reuses the exact npm/wheel artifacts and offline evidence from Candidate `33838498153`. The manifest records their original build commit and `providerCertification: not-run`. No partial green check establishes public availability, and the `0.7.0` network exception is not reused.
- The non-regression coverage gate passes, but repository lines, statements, and branches remain below the long-term 80% target, and selected safety-critical branches remain below 90%.
- Lifecycle extensions are controlled in-process extensions, not an operating-system sandbox. Only four events are exposed, and unknown project extensions are not loaded by default.
- Windows host-shell safety depends on the permission, workspace, and network combination. Only the built-in Linux shell uses the additional network-disabled isolation; the two are not equivalent sandboxes.
- The Python SDK uses its bundled Node Worker and still requires Node.js `>=22.19`; there is no independent pure-Python Runtime.
- Checkpoints and effect receipts provide recovery and idempotency correlation evidence, but cannot guarantee exactly-once behavior in an external business system. Uncertain effects require a pause and human verification.
- Local deterministic compaction remains the default and project Memory is not created automatically. Experimental strategies never switch themselves on.
- Child Run does not support durable detach, standalone spawn/list/resume commands, Goals, or Jobs; Web is out of scope for this release.
- The candidate does not provide a hosted API, multi-tenant SaaS, official Docker image, formal macOS support, or extension marketplace.
- The `v0.7.1` tag, GitHub Release, eight npm packages, and PyPI package must share one version. The manifest separately records the package build commit and source ZIP release commit, with no product-code changes between them. Public channels remain authoritative for installable availability.
