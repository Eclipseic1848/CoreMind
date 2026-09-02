# 0.7.0 Stable Candidate Known Limitations

> This file records the capability boundary of the unpublished `0.7.0` candidate. `0.3.1` remains the public stable release, and Releases and registries remain authoritative for installation.

- All 40 provider entries are configurable, but `0.7.0` has no successful live parent-child Agent certification. The first Provider request in strict run `33582995518` timed out before an HTTP response; the maintainer accepted this as a version-specific network exception. It is not a live-provider success, and evidence for `0.3.2` or earlier remains historical only.
- The phase-two live external same-task model evaluation has not run. Offline Coding Eval does not establish live-model quality.
- Candidate packages, both-platform TTY, the Runtime digest, the network exception, and public-release evidence for `0.7.0` must remain exactly correlated. No partial green check establishes public availability.
- The non-regression coverage gate passes, but repository lines, statements, and branches remain below the long-term 80% target, and selected safety-critical branches remain below 90%.
- Lifecycle extensions are controlled in-process extensions, not an operating-system sandbox. Only four events are exposed, and unknown project extensions are not loaded by default.
- Windows host-shell safety depends on the permission, workspace, and network combination. Only the built-in Linux shell uses the additional network-disabled isolation; the two are not equivalent sandboxes.
- The Python SDK uses its bundled Node Worker and still requires Node.js `>=22.19`; there is no independent pure-Python Runtime.
- Checkpoints and effect receipts provide recovery and idempotency correlation evidence, but cannot guarantee exactly-once behavior in an external business system. Uncertain effects require a pause and human verification.
- Local deterministic compaction remains the default and project Memory is not created automatically. Experimental strategies never switch themselves on.
- Child Run does not support durable detach, standalone spawn/list/resume commands, Goals, or Jobs; Web is out of scope for this release.
- The candidate does not provide a hosted API, multi-tenant SaaS, official Docker image, formal macOS support, or extension marketplace.
- GitHub Releases, npm, and PyPI are authoritative for installable availability. `0.7.0` is not yet present in any public channel.
