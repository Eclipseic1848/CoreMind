# CoreMind Public Roadmap

CoreMind helps newcomers and application engineers build reliable business agents through configuration, one standard runtime, a bounded harness and loop, quality gates, and task-oriented learning materials.

This public roadmap describes product boundaries and intended directions. It deliberately excludes internal schedules, acceptance records, and maintainer working notes. Priorities may change as real users and community contributors provide feedback.

## Current release line: `1.3.0`

`0.2.0-rc.1` remains the immutable reference baseline. GitHub Releases, npm, and PyPI determine the latest installable version in each channel. The `1.3.0` release line upgrades from published `1.2.0`, focusing on safety, cancellation, data ownership, cross-language tools, and diagnostics while retaining the 1.1 work included in 1.2. Use the [1.2→1.3 migration guide](migrations/1.2-to-1.3.en.md); earlier upgrades remain in the [historical guide](migrations/1.0-to-1.2.en.md). Current source retains these capabilities:

- Three use paths: CLI/TUI, TypeScript and Python SDKs, and full source.
- Single-agent and multi-agent execution, workflows, and budget-bounded loops.
- Compatible Config v2, explicit Config v3, 43 configurable provider entries including compatibility aliases, and custom compatible endpoints.
- `ask`, `assisted`, and `full` permission modes with path policy, approvals, audit, checkpoints, diffs, and recovery.
- Explicit outcomes, budgets, traces, sessions, context protection, tests, evaluations, and release gates.
- Eight project templates, five offline golden examples, two real-defect coding-agent repositories, and 22 capability modules.
- Tests, SOPs, a Skill, bilingual guides, and examples for every capability module.
- Acceptance workflows that combine Windows/Linux automation with real pseudoterminal checks on both platforms, plus synchronized GitHub, npm, PyPI, and bilingual documentation releases.
- Explicit correlation across the Session, Run, and Workspace fact domains; typed identity; I-1 through I-12 invariant checks; input receipts; request rebuilding; and cancellation convergence.

The `v1.3.0` tag, [GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases), eight npm packages, and [PyPI package](https://pypi.org/project/coremind-ai/) must share one version, with package-build and source-ZIP release commits recorded separately in the release manifest. Live channel pages and same-commit qualification evidence determine public availability; passing source CI does not establish publication. Older release records remain historical and do not qualify this version.

It includes the public `loop` configuration, verify-repair states, stable snapshots, pause-resume, effect receipts, bounded retries, a fifth verified-repair golden example, plus the controlled process, read-only Git, bounded unified diff, seven grader types, and TypeScript/Python real-defect evaluations required by coding agents. Release qualification and Provider certification are tracked separately. Formal publication also requires strict-provider evidence bound to this version, final commit, Runtime, and Worker.

## `1.3.0`: audit fixes and consistent behavior across entry points

- Strengthen tool-write protection for framework persistent state, retaining separate host-code trust and execution-permission boundaries.
- Cancel parallel siblings on the first failure and wait for cleanup; terminal runs reject late execution admission.
- Generate Python parameter Schemas from deferred annotations while retaining existing conversion and explicit Schema paths.
- Save only newly generated Workflow step answers as output while retaining history as model context.
- Compare Git status and content in Diff graders, including baseline paths that disappear from the final status list.
- Preserve shared error identities and redacted audit values for initialization or background failures of accepted Protocol v2 runs.
- Await Web response-body cancellation attempts after HTTP/read errors before settling activity, retaining the original error.
- Make readline `/exit` and `!exit` abort and join the current turn while EOF retains natural completion.
- Check the selected Provider's credentials in doctor without rejecting keyless/Header-only endpoints, loading scripts, or sending requests.
- Align bilingual security-support status with the latest formal Release while retaining disclosure and safety boundaries.

This version's strict Provider, both-platform candidate, and public reinstall qualification still require separate evidence bound to the final version, commit, and exact artifacts. Older results do not substitute for it. See the [1.3 release notes](release/notes/v1.3.0.md).

## Published `1.2.0`: reliability, controlled extensions, and interactive evidence

Accepted fixes cover Session writes/recovery, final tool arguments, cross-model request views, safe transient retry, model output limits, custom authentication, output delivery, and consumer dependency identity. Duplicate Call identity handling, critical journal prefix processing, and Python notification consumption have also merged with acceptance. This release line includes the following improvements:

- Critical journal prefix processing that retains complete reads/writes and synchronization, with no overall performance promise.
- Atomic Python four-bucket notification drain, retaining default history, host responses, and durable-cursor contracts.
- Explicit trust before project-script imports, with matching SDK/Worker upgrades and separate execution authority.
- Grapheme cursors, middle editing, draft recovery, and bounded ordinary-input history, retaining approval/paste isolation.

Windows MCP startup uses fixed Job assets and a thin launcher while retaining the original 15-second call and 60-second connection gates. Formal publication requires strict Provider, both-platform engineering/stability/coverage/real PTY, and public download/reinstall evidence bound to the final commit and exact artifacts.

### Unpublished 1.1 development included in this release line

- Standard `SKILL.md` indexing, on-demand loading, and frozen-snapshot recovery.
- Durable same-Run `/steer`, `/follow-up`, and five-state control receipts.
- Permission-gated local MCP stdio tools and cancellation settlement.
- Fixed HTTP MCP targets, exact resource authorization, and controlled credentials.
- Explicit host OAuth login, cancellation, exit, and logout.
- Explicit Config v3 `deferred` Chinese/English lexical discovery, declaration generation, and fact reconstruction.
- Terminal evidence per Run/Call, controlled Artifact references, and safe input.

Config v2, omitted or explicit `direct` tools, and Protocol v1 remain compatible; `deferred` requires explicit Config v3. New features require matching SDK and bundled Worker capabilities; Protocol v2 also requires matching Schema fingerprints. Node.js ≥ 22.19 is required, and the Python SDK requires Python ≥ 3.10. Unknown effects still require human reconciliation before resume. Skill loading and tool discovery grant no new permissions. Real external authorization-server interoperability and global paired performance gains are not certified.

## `1.0.1`: Runtime safety and integration hardening

Hardens authorized targets, network preapproval, Trace credentials, budgets and summary authentication, resume admission, shutdown races, Python tool identity, and terminal cancellation. Config v2, Protocol v1/v2, and the unified Node Runtime remain. See the [upgrade guide](migrations/0.8-to-1.0.en.md) and [changelog](../CHANGELOG.en.md). Publication still requires this version's strict qualification and public artifact evidence.

## `0.8.0`: host verification and audit fixes

Runs durably receive independent host verification before success, with rejection using the same Run for bounded repair. Fixes and regressions cover default tool paths, Restore write leases, session exclusion, Run turn budgets, Python callbacks, script aliases, TUI result identity, response-byte limits, and Windows lock stability. Release qualification still requires current-candidate evidence from both platforms, a live Provider, and public artifacts. MCP/LSP and remote execution environments are outside this release.

## `0.7.1`: stability and release-evidence hardening

This release does not change the Protocol wire contract. It expands sensitive Header alias checks so custom Providers cannot store plaintext credentials; Artifact import rejects symlinks, canonical-path escapes, and file-identity races; normal RunStore append writes only the new Fact; and long-lived Protocol v2 hosts reclaim terminal idempotency caches while rebuilding duplicate/conflict decisions from the authoritative journal. Protocol v1 remains supported with no approved removal plan.

The TUI no longer clears unsent ordinary input while a Run is busy. Release failures print P0 blockers, retain reports, and continue Registry reinstall verification after public artifacts exist. Python package metadata now matches stable-release maturity. No Provider has same-version live certification, and older network exceptions or certification evidence cannot be reused.

## `0.7.0`: Child Run stable release

This release aligns the root package, eight npm packages, Python SDK, bundled Worker, module contracts, and release metadata on `0.7.0`. It combines the 0.3.x-B/C work with Protocol v2, one Error Contract, the Execution Security Gate, and a Config-v2-gated Child Run product path shared by CLI/TUI/TypeScript/Python.

The P0 implementation, Node 22 engineering checks, candidate npm tarballs, Python wheel, bundled Worker, TTY, and Child Run gates pass on both platforms. The strict Provider request timed out before an HTTP response; the maintainer accepted an exactly bound, `0.7.0`-only network exception, which is not a live-provider certification. Tag, GitHub Release, and registry publication are complete. `0.3.2` evidence remains historical only.

## `0.3.x`: historical stabilization line

The `0.3.x` line hardens runtime semantics in three approved batches (A → B → C) through compatibility-first evolution. It does not create a second Runtime or pull Web, Jobs, or subagents forward. Config v2, Protocol v1, the three permission modes, and existing successful paths remain compatible; new fail-closed states that prevent silent loss, duplicate effects, or privilege expansion must be explicit, migratable, reversible, and maintainer-confirmed:

- **0.3.x-A: facts, identity, and cancellation convergence** — a single source of truth with derived projections (three fact domains: Session / Run / Workspace), typed identity and correlation invariants, and cancellation convergence with input receipts. The design and implementation issues [#35–#42](https://github.com/Eclipseic1848/CoreMind/issues/35) are complete and publicly released in `0.3.1`.
- **0.3.x-B: tools and recovery** — one resolved Tool Capability, an explicit stage graph with monotonic security, tiered Durability Barriers, a single-writer Workspace lease, persistence failure contracts, and orthogonal error results. It ships in `0.7.0`.
- **0.3.x-C: evidence system** — event replay and real-entry testing, a cross-model long-horizon Context lifecycle, critical-module gates, provider certification hardening, and locally visible observability with explicit egress. It ships in `0.7.0`.

Version numbers and dates are not promised; each batch proceeds only after its acceptance gates pass and the maintainer confirms. A provider that has not passed live verification remains configurable but is not marked as officially certified.

## Future roadmap (version scope to be confirmed)

The 1.3.0 release line focuses on audit fixes to existing capabilities. The following directions still require independent scope and acceptance; obsolete version assignments from early plans no longer define their schedule:

- Web development environment: run and control surfaces first, followed by editing, testing, and evaluation, reusing the existing Protocol and Runtime.
- More MCP service interoperability, LSP, controlled third-party plugins, remote execution environments, and platform integrations: proceed after separate security contracts and compatibility gates are agreed.
- Later stable versions: improve compatibility, security, and auditable publication from real defects and community feedback, without unconfirmed dates.

## `0.3.0`: phase-two kernel and engineering loop

Phase two advances through `alpha → beta → rc` and strengthens the framework kernel without changing CoreMind's three use paths:

- Align critical dependency versions and isolate low-level implementations behind private adapters.
- Establish durable harness operations that can abort, pause, resume, and recover without duplicating committed effects.
- Improve context selection, compaction evidence, long-output artifacts, and observable metrics.
- Build a first-party Coding/Engineering Kernel for repository understanding, minimal edits, diffs, verification, repair, and regression.
- Keep outcomes, events, approvals, and recovery consistent across TUI, headless CLI, TypeScript SDK, and Python SDK.
- Ship tests, SOP, Skill, bilingual guides, examples, migration, and rollback guidance with every batch.

`0.3.0-rc.2` completed Batches 0 through 6: critical dependencies use one exact family behind private adapters; runs have a durable operation envelope, atomic RunState, Session backend conformance, backed-up migration, and non-replay boundaries for uncertain effects; long tasks add stable context prefixes, deterministic compaction evidence, truthful cache metrics, and controlled workspace artifacts; coding is a first-party Engineering Kernel inside the Runtime; and the extension surface is limited to four controlled lifecycle events with traceable experiments, a seven-check provider contract, TUI evidence views, and one shared `RunSnapshot` across all entry points. The `0.3.0` stable release adds no product behavior and only synchronizes stable versions and release materials. The current evidence ledger, Releases, and registries remain authoritative for candidate provider status, public availability, and final assets.

Phase two starts from an immutable `0.2.0-rc.1` reference baseline that freezes public types, Config/Protocol schemas, the critical dependency combination, P01-P20, both-platform behavior, same-task coding-evaluation conditions, and quality floors. Coverage may improve but may not regress. Every intentional contract change must explain migration and rollback; gates are never lowered merely to pass.

## Phase three: Web development environment

Phase three is planned to add a complete browser-based development experience:

- Visual configuration of agents, tools, and workflows.
- Online code editing and project file management.
- Trace debugging, testing, and evaluation panels.
- Permission approval, run-state, and result inspection.
- Release and deployment guidance.

The Web environment will reuse CoreMind Protocol and the existing runtime instead of introducing another execution engine.

## Later platform and ecosystem work

- Formal macOS support.
- More community templates, Skills, business modules, and golden examples.
- Live certification for additional model providers.
- Continued improvements to contributor development, testing, review, and release workflows.

Every new capability must continue to ship with implementation, tests, SOP, Skill, bilingual guidance, and examples.

## Explicit boundaries

CoreMind does not decide business goals, data fields, approval ownership, or agent architecture for users, and it does not promise to implement every business application automatically. There is currently no plan for an official hosted API, multi-tenant SaaS, official Docker image, or separate pure-Python runtime.

Users own business direction and final acceptance. CoreMind owns engineering mechanisms, safety boundaries, quality evidence, and development guidance.

## Participate in the roadmap

Use [GitHub Issues](https://github.com/Eclipseic1848/CoreMind/issues) for adoption feedback, defects, and capability proposals. Before contributing code, read the [contribution guide](../CONTRIBUTING.en.md) and [security policy](../SECURITY.en.md).
