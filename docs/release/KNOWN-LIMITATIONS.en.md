# 1.1.0 Known Limitations

> This file records the capability boundary of the `1.1.0` release line. Live GitHub Release, npm, and PyPI pages and same-commit qualification evidence determine public availability; source CI does not establish publication.

- All 43 catalog entries (42 built-in chat providers, including compatibility aliases) are configurable; this is not live certification. Version 1.1.0 requires strict-provider evidence bound to its candidate version, final commit, and Runtime digest. Older certification and release exceptions do not substitute for it.
- The phase-two live external same-task model evaluation has not run. Offline Coding Eval does not establish live-model quality.
- Publication requires the non-regression coverage gate. The `1.0.1` record places repository lines, statements, and branches below the long-term 80% target and selected safety-critical branches below 90%. Actual `1.1.0` values require its same-commit coverage report; older values do not describe the current run.
- Lifecycle extensions are controlled in-process extensions, not an operating-system sandbox. Only four events are exposed, and unknown project extensions are not loaded by default.
- Windows host-shell safety depends on the permission, workspace, and network combination. Only the built-in Linux shell uses the additional network-disabled isolation; the two are not equivalent sandboxes.
- The Python SDK uses its bundled Node Worker and requires Python `>=3.10` and Node.js `>=22.19`; there is no independent pure-Python Runtime. New capabilities need a matching SDK/Worker, and Protocol v2 Schema fingerprints must agree. Ignored fields in an older Worker do not establish support.
- Checkpoints and effect receipts provide recovery and idempotency correlation evidence, but cannot guarantee exactly-once behavior in an external business system. Uncertain effects require a pause and human verification.
- Local deterministic compaction remains the default and project Memory is not created automatically. Experimental strategies never switch themselves on.
- Child Run does not support durable detach, standalone spawn/list/resume commands, Goals, or Jobs; Web is out of scope for this release.
- The candidate does not provide a hosted API, multi-tenant SaaS, official Docker image, formal macOS support, or extension marketplace.
- The `v1.1.0` tag, GitHub Release, eight npm packages, and PyPI package must share one version. The manifest separately records the package build commit and source ZIP release commit, with no product-code changes between them. Public channels remain authoritative for installable availability.

- Trace fragments without whitespace may wait until the turn ends; an unclosed fragment has a 65,536-character safety limit. Credential-bearing step candidates fail explicitly without silently changing verification hashes.
- v1 Python cancellation ends local waiting, not unconfirmed external execution. Linux Web host networking does not inherit Shell sandbox isolation.

## 1.1.0 extension and interaction boundaries

- Standard Skills load only explicitly selected local `SKILL.md` files and freeze their bodies when the Runtime is created. Built-in and README Skills retain their legacy path. No remote Skill scan, script execution, or permission grant is implied.
- Durable `/steer` and `/follow-up` neither create concurrent Runs nor change the Provider, permissions, or budget. The `accepted/applied/rejected/duplicate/conflict` receipts do not establish actual model input claim or completion.
- Local MCP stdio is a trusted host process with the current account's authority; allowlists or roots are not an operating-system sandbox. Unknown external effects after cancellation require human reconciliation without automatic replay.
- HTTP MCP uses only fixed targets, exactly authorized resource URIs, and controlled credentials. It provides no arbitrary host-path reads or binary-resource fallback. Child Runs inherit no MCP service, resource, or credential authority.
- OAuth starts only through explicit host action; users open the authorization link themselves and can cancel or log out. The loopback callback must be reachable. Unsupported authentication does not downgrade automatically, and business 401/403 responses do not trigger implicit login. Actual external authorization-server/MCP interoperability is not certified.
- Config v2, default/explicit `direct`, and Protocol v1 remain compatible; `deferred` requires explicit Config v3. Chinese/English discovery is lexical matching within the authorized catalog, not translation or semantic search. Rebuildable declaration generation does not establish full-session reconstruction; matches still need durable installation and existing execution approval.
- The terminal retains a bounded display window. Missing Call/Run provenance, execution duration, or results stay explicitly unknown without guessed correlation or success. Artifacts show only stored/blocked status and controlled references; the interface neither reads nor opens arbitrary output paths. Safe paste-as-draft is not approval.

Global paired performance gains are not certified, with no overall throughput, latency, or resource-saving promise. Release bodies use only reviewed fixed bilingual text with a unique commit injection, and an existing-body conflict stops recovery. Final Provider, candidate, and public reinstall qualification still require separate evidence under the [Release SOP](README.en.md).
