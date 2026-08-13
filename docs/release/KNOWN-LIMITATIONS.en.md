# 0.3.0 Stable Candidate Known Limitations

> This file records the truthful boundary of the unpublished `0.3.0` stable candidate. Use Releases and registries to determine whether acceptance and publication have completed.

- All 40 provider entries are configurable. `alibaba-model-studio/qwen-plus` has completed the seven-check live revalidation on the `0.3.0` candidate Runtime, while the other 39 remain uncertified. Final status comes from the current-version evidence ledger. Never present configurability as certification or generalize one model's evidence to another model or deployment.
- The phase-two live external same-task model evaluation has not run. Offline Coding Eval does not establish live-model quality.
- Every publishable tag must bind to the same source that passed P01-P19, Windows/Linux CI, real P20 pseudoterminal acceptance on both platforms, and the live-provider recheck. Candidate checks must not be presented as public availability while any release channel lacks the version.
- The non-regression coverage gate passes, but repository lines, statements, and branches remain below the long-term 80% target, and selected safety-critical branches remain below 90%.
- Lifecycle extensions are controlled in-process extensions, not an operating-system sandbox. Only four events are exposed, and unknown project extensions are not loaded by default.
- Windows host-shell safety depends on the permission, workspace, and network combination. Only the built-in Linux shell uses the additional network-disabled isolation; the two are not equivalent sandboxes.
- The Python SDK uses its bundled Node Worker and still requires Node.js `>=22.19`; there is no independent pure-Python Runtime.
- Checkpoints and effect receipts provide recovery and idempotency correlation evidence, but cannot guarantee exactly-once behavior in an external business system. Uncertain effects require a pause and human verification.
- Local deterministic compaction remains the default and project Memory is not created automatically. Experimental strategies never switch themselves on.
- The candidate does not provide a complete Web development environment, hosted API, multi-tenant SaaS, official Docker image, formal macOS support, or extension marketplace.
- GitHub Releases, npm, and PyPI are authoritative for installable availability. If `0.3.0` is absent from any channel, do not infer that stable publication has completed.
