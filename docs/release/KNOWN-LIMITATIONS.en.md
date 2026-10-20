# 1.3.0 Known Limitations

> This file records the capability boundaries of the `1.3.0` release line. Upgrade from published `1.2.0`, retaining its included 1.1 capabilities. See the [1.2→1.3 migration guide](../migrations/1.2-to-1.3.en.md). Live GitHub Release, npm, and PyPI pages and same-commit qualification evidence determine public availability; source CI does not establish publication.

- All 43 catalog entries (42 built-in chat providers, including compatibility aliases) are configurable; this is not live certification. Version 1.3.0 requires strict-provider evidence bound to its candidate version, final commit, and Runtime digest. Older certification and release exceptions do not substitute for it.
- The phase-two live external same-task model evaluation has not run. Offline Coding Eval does not establish live-model quality.
- Publication requires the non-regression coverage gate. The `1.0.1` record places repository lines, statements, and branches below the long-term 80% target and selected safety-critical branches below 90%. Actual `1.3.0` values require its same-commit coverage report; older values do not describe the current run.
- Lifecycle extensions are controlled in-process extensions, not an operating-system sandbox. Only four events are exposed, and unknown project extensions are not loaded by default.
- Windows host-shell safety depends on the permission, workspace, and network combination. Only the built-in Linux shell uses the additional network-disabled isolation; the two are not equivalent sandboxes.
- The Python SDK uses its bundled Node Worker and requires Python `>=3.10` and Node.js `>=22.19`; there is no independent pure-Python Runtime. New capabilities need a matching SDK/Worker, and Protocol v2 Schema fingerprints must agree. Ignored fields in an older Worker do not establish support.
- Checkpoints and effect receipts provide recovery and idempotency correlation evidence, but cannot guarantee exactly-once behavior in an external business system. Uncertain effects require a pause and human verification.
- Local deterministic compaction remains the default and project Memory is not created automatically. Experimental strategies never switch themselves on.
- Child Run does not support durable detach, standalone spawn/list/resume commands, Goals, or Jobs; Web is out of scope for this release.
- The candidate does not provide a hosted API, multi-tenant SaaS, official Docker image, formal macOS support, or extension marketplace.
- The `v1.3.0` tag, GitHub Release, eight npm packages, and PyPI package must share one version. The manifest separately records the package build commit and source ZIP release commit, with no product-code changes between them. Public channels remain authoritative for installable availability.

- Trace fragments without whitespace may wait until the turn ends; an unclosed fragment has a 65,536-character safety limit. Credential-bearing step candidates fail explicitly without silently changing verification hashes.
- v1 Python cancellation ends local waiting, not unconfirmed external execution. Linux Web host networking does not inherit Shell sandbox isolation.

## Boundaries of the 1.3.0 fixes

- Tool-write protection for internal persistent state does not isolate arbitrary host code. Ordinary file writes reject targets with multiple hard links; consult the migration guide when arranging business paths.
- Parallel failure and explicit readline exit abort and join active work. Cancellation neither rolls back existing effects nor forcibly stops arbitrary host functions. Piped readline EOF retains natural completion of the current answer.
- Python parameter Schema inference covers the previously supported types and retains Node-side Schema conversion and validation. Provide explicit `parameters` for complex types; unresolved parameter annotations fail explicitly.
- Workflow step output excludes old answers while history remains model context. Diff graders count status or content changes and retain stage/unstage semantics; disabling dirty-file preservation does not disable other path or count constraints.
- Protocol v2 retains shared error codes and redacted audit values for accepted runs. Unknown exceptions still require human action; a queryable failure does not establish permission to resume directly.
- Web error paths await response-body cancellation attempts before settling local network activity; cleanup errors do not replace the original failure. Remote TCP events need not occur synchronously. The existing `web-fetch` 2 MiB response limit remains.
- doctor performs static checks using the selected Provider's policy for keyless/Header-only endpoints. Missing explicit credentials and built-in requirements still reject; diagnostic success does not establish credential validity or connectivity.

## Extension and interaction boundaries retained from 1.2.0

- Standard Skills load only explicitly selected local `SKILL.md` files and freeze their bodies when the Runtime is created. Built-in and README Skills retain their legacy path. No remote Skill scan, script execution, or permission grant is implied.
- Durable `/steer` and `/follow-up` neither create concurrent Runs nor change the Provider, permissions, or budget. The `accepted/applied/rejected/duplicate/conflict` receipts do not establish actual model input claim or completion.
- Local MCP stdio is a trusted host process with the current account's authority; allowlists or roots are not an operating-system sandbox. Unknown external effects after cancellation require human reconciliation without automatic replay.
- HTTP MCP uses only fixed targets, exactly authorized resource URIs, and controlled credentials. It provides no arbitrary host-path reads or binary-resource fallback. Child Runs inherit no MCP service, resource, or credential authority.
- OAuth starts only through explicit host action; users open the authorization link themselves and can cancel or log out. The loopback callback must be reachable. Unsupported authentication does not downgrade automatically, and business 401/403 responses do not trigger implicit login. Actual external authorization-server/MCP interoperability is not certified.
- Config v2, default/explicit `direct`, and Protocol v1 remain compatible; `deferred` requires explicit Config v3. Chinese/English discovery is lexical matching within the authorized catalog, not translation or semantic search. Rebuildable declaration generation does not establish full-session reconstruction; matches still need durable installation and existing execution approval.
- The terminal retains a bounded display window. Missing Call/Run provenance, execution duration, or results stay explicitly unknown without guessed correlation or success. Artifacts show only stored/blocked status and controlled references; the interface neither reads nor opens arbitrary output paths. Safe paste-as-draft is not approval.

## Inherited reliability boundaries

- Session leases require a hard-link-capable local filesystem, not a distributed lock. Recovery verifies owners rather than deleting active locks by age; only an unrecoverable JSONL tail is truncated, while middle corruption rejects.
- Malformed final tool-argument structure cannot execute. Output-length termination fails with `model_output_limit`, retains partial text, and does not continue or execute attached tools. Model changes preserve answers and tool pairing; same-model signatures have local-payload fidelity, not external signature acceptance.
- Custom compatible endpoints can be keyless or Header-only. Missing explicit credential references still reject, and built-in/native requirements remain. Transient retries retain budget/effect gates; steps with started writes, external effects, or delegation are not replayed wholesale.
- The non-Ink CLI and Worker stdio queue allows 64 MiB UTF-8 / 1024 entries, including in-flight entries. It is not a limit on RSS, transient serialization, or model generation. Critical output failure is identifiable, but the 10-second flush deadline cannot force-stop host functions or physical writes; disconnected SDKs may see only `WorkerExitedError`.
- Duplicate Call identity handling has merged and passed both-platform CI. Identical Agent/Step/Call identities in a Run or same-Run recovery must not create another Fact or tool effect; new identities retain valid execution.
- Merged critical-prefix hits reduce parsing/serialization only, retaining full reads/writes and synchronization; Python four-bucket draining provides no server acknowledgement, automatic memory cap, or durable-cursor advance. Trust before project-script import grants no tool authority, dependency freezing, or OS sandbox. Grapheme editing and at most 50 ordinary entries in the current interface do not form a full editor. See the [migration guide](../migrations/1.0-to-1.2.en.md).
- Windows MCP startup uses fixed Job assets and a thin launcher while retaining the original 15-second call and 60-second connection gates. Formal publication requires strict Provider, both-platform engineering/stability/coverage/real PTY, and public download/reinstall evidence bound to the final commit and exact artifacts.

Global paired performance gains are not certified, with no overall throughput, latency, or resource-saving promise. Release bodies use only reviewed fixed bilingual text with a unique commit injection, and an existing-body conflict stops recovery. Final Provider, candidate, and public reinstall qualification still require separate evidence under the [Release SOP](README.en.md).
