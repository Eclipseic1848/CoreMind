# CoreMind Changelog

This file records user-facing changes. Versions follow Semantic Versioning; prereleases may include explicitly documented interface changes.

[简体中文](CHANGELOG.md)

## 0.3.0-rc.1 — 2026-08-12

### Closure and release preparation

- Synchronized the root manifest, eight public npm packages, exact internal dependencies, lockfile, and Python SDK to npm `0.3.0-rc.1` / Python `0.3.0rc1`.
- Added bilingual 0.2-to-0.3 migration guides, known limitations, and a bilingual SOP/Skill index for all 21 modules; synchronized the root README, public roadmap, provider status, and release SOP.
- Extended `.gitignore` for virtual environments, type-checker caches, coverage data, and local registry credentials. Source archives continue to exclude internal analyses, handoff notes, sessions, run evidence, secrets, caches, and build outputs.
- Added a Markdown gate for Chinese/English paragraph boundaries and split bilingual package READMEs into independent language sections instead of appending an English translation to a Chinese description.
- Changed the both-platform CI checkout to full history so the frozen baseline can resolve the immutable `v0.2.0-rc.1` tag, with a workflow-contract test preventing shallow-checkout regression.
- Aligned CI and documentation workflows on the same current pinned Action commits used by the release workflow, removing legacy-runtime deprecation warnings while retaining full commit-SHA pinning.
- The frozen-baseline command now rebuilds all eight public packages before collecting API contracts, so stale `dist` output cannot hide source-level type drift. The Runtime denial-stop hook remains internal and does not expand the public API.

### Current verification evidence

- The P01-P19 test anchors are synchronized with the RC automated matrix. Across the repository, 69 test files pass and one is conditionally skipped; 465 tests pass and four are conditionally skipped. The Python SDK and real bundled Worker pass 10/10, and offline Coding Eval passes 6/6.
- The first Windows P20 run found that a model could treat a human denial as an ordinary tool error and request approval again. The Runtime now blocks the denied tool and later unapproved calls in the same batch, returns `paused` after the batch is reconciled, and makes no next model request. In a sequential workflow, the denied step saves no output and no later step starts. Single-tool, mixed-tool, and two-step workflow regressions all assert zero write side effects.
- All three post-fix stability runs pass 465 tests with four conditional skips and zero drift. Coverage is 75.83% lines, 73.93% statements, 83.19% functions, and 66.96% branches. The non-regression gate passes, while the repository-wide 80% and selected 90% safety-branch targets remain long-term goals.
- All eight npm tarballs pass content allowlists, publint, type resolution, clean-project installation, and ESM imports. The CLI reports `coremind v0.3.0-rc.1`.
- The Python wheel passes content checks, clean-venv installation, version parity, and bundled-Worker startup. The standalone source ZIP completes clean installation, build, contract checks, and CLI startup in isolation.
- Contracts pass for 21 modules, five golden examples, 14 bilingual documentation-site pairs, and 410 Markdown files, including strict UTF-8, local links, public identifier boundaries, and Chinese/English paragraph separation.
- `alibaba-model-studio/qwen-plus` completed live streaming, tool-call, structured-result, multi-turn, abort, error-mapping, and long-context checks against `0.3.0-rc.1`. The redacted evidence contains no secret, prompt body, or response body.

### Release gates still open

- The final commit is not frozen. Windows and Linux P20 real-TTY evidence must bind to the same final commit; historical `0.2.0-rc.1` evidence cannot be reused.
- All 40 providers are configurable. One has completed the seven-check live revalidation for `0.3.0-rc.1`, while the other 39 remain configurable but uncertified. The release workflow and both-platform CI must still pass on the final commit.
- The phase-two live external same-task model comparison was explicitly deferred. Offline 6/6 evidence does not establish live-model quality.
- No tag, GitHub Release, npm publication, or PyPI publication occurs until these gates pass and the final clean-worktree preflight succeeds.

## 0.3.0-beta.2 — 2026-08-11 (source candidate, unpublished)

### Added

- Limited lifecycle extensions to `before-model`, `before-tool`, `after-tool`, and `run-finished`. Extensions declare trust, capabilities, and grants explicitly; unknown project extensions are not loaded by default.
- Added the lightweight experiment → arm → run → trace contract with version, environment, input fingerprint, random seed, run, complete trace, and existing grader results.
- Added `RunResult.snapshot` plus Protocol validation so CLI, Worker, TypeScript, and Python share operation, outcome, metrics, evaluation, trace, checkpoints, artifacts, extension receipts, and resumability.
- Added TUI `/artifacts` and `/context`; `/status` now covers terminal state, recovery, compaction, artifacts, and evaluation.
- Expanded provider certification to seven checks: streaming, tool calls, structured results, multi-turn, abort, error mapping, and long context. Older five-check evidence remains traceable but no longer counts as current certification.
- Added the twenty-first capability module, Runtime Lifecycle Extensions, and synchronized recovery, evaluation, provider, CLI, and both-SDK SOPs, Skills, bilingual guides, and examples.

### Safety, evidence, and boundaries

- An extension may deny a tool but cannot approve an operation rejected by the permission layer. Extension timeout or failure cannot bypass permissions or checkpoints or rewrite the true terminal state.
- Targeted core/protocol/CLI tests passed 88/88, Python SDK and real Worker tests passed 10/10, and Coding Eval passed 6/6. Repository tests passed 458 with 4 conditional skips.
- Coverage is 75.76% lines, 73.86% statements, 83.13% functions, and 66.85% branches; the non-regression gate passes, while the long-term 80% repository and selected 90% safety-branch targets remain open.
- All 40 provider entries are configurable, but none has completed the new seven-check live revalidation. Linux CI, real TTY acceptance on both platforms, and live-provider revalidation remain RC prerequisites.
- This candidate does not add a Web UI, an independent Python Loop, an extension marketplace, or a second terminal-state model.

## 0.3.0-beta.1 — 2026-08-11 (source candidate, unpublished)

### Added

- Promoted coding from an example composition to a first-party Engineering Kernel inside the Runtime, exposing repository inspection, explicit environment selection, repository maps, six-phase engineering plans, bounded verify/repair loops, and delivery evidence.
- Standardized read/search/write/edit/process/Git contracts. Every file change must reference a pre-write checkpoint, while process and network access continue through the shared permission boundary.
- Added deterministic TypeScript and Python cross-file defects, wrong commands, approval denial, abort, diff, and restore cases alongside the existing real single-file defect evaluations.

### Evidence and boundaries

- Repository tests: 443 passed and 4 conditionally skipped. Coding evaluation: 6/6. Coding Kernel coverage: 92.45% lines and 87.12% branches.
- A test that did not run or failed cannot be claimed as passed. Ambiguous language, package-manager, or test-command evidence requires an explicit user choice.
- This candidate does not add browser automation, desktop control, an LSP cluster, worktree orchestration, or an extension marketplace. Config v2, Protocol v1, and generic terminal semantics remain unchanged.

## 0.3.0-alpha.3 — 2026-08-11 (source candidate, unpublished)

### Added

- Added a byte-stable context prefix and SHA-256 fingerprint with fixed ordering for core rules, project instructions, tools, stable facts, and skills.
- Added a controlled artifact store that streams large output into the workspace while exposing only a bounded head-tail preview, summary, hash, and relative reference to the model.
- Added context/artifact metrics, real cache read/write token accounting, offline strategy comparison, and the twentieth bilingual capability module.

### Security and compatibility

- Suspected credentials never enter previews or artifacts. Untrusted full-output paths are not read or deleted, and resolved artifact paths cannot escape the workspace.
- Config v2 and Protocol v1 requests are unchanged. `RunMetrics.context`, `RunMetrics.artifacts`, and `RunResult.artifacts` are additive optional fields that normal runtime results populate.
- Local deterministic compaction remains the default. Project memory is never created automatically, and candidate strategies do not switch themselves on.

## 0.3.0-alpha.2 — 2026-08-10 (source candidate, unpublished)

### Added

- Added a durable operation envelope and `RunResult.operation` so CLI, TUI, TypeScript, and Python read the same run state.
- Added one Memory/JSONL Session conformance suite plus RunState fault-injection, competing-writer, and incomplete-tail recovery tests.
- Added the nineteenth capability module, Durable Runs and Recovery, with bilingual README/GUIDE/SOP documents, a Skill, examples, and migration/rollback guidance.

### Changed

- RunState now uses a single-writer lock, consecutive sequences, and temporary-file atomic publication. Automatic repair is limited to an incomplete final line after complete records.
- Tool calls, effect receipts, checkpoints, operations, and terminal records share run/call/idempotency correlation. Uncertain effects or effects without stable ownership are never replayed automatically.
- A legacy schema-v3 Session receives a `.v3.backup` before first-open migration. Migration is idempotent and fails closed without replacing entries that cannot be represented losslessly.

### Compatibility and rollback

- Config v2 and Protocol v1 requests are unchanged. CLI `run_result` adds only the `operation` field while preserving existing fields and exit codes.
- Terminal operations cannot resume. Legacy sessions can roll back from the documented backup; external effects still require business-system idempotency or human verification.

## 0.3.0-alpha.1 — 2026-08-10 (source candidate, unpublished)

### Added

- Added a CoreMind-owned Runtime compatibility report, exposed through the TypeScript SDK and `coremind doctor`, for dependency-family, adapter, error-mapping, and capability checks.
- Added an immutable reference baseline and a separate candidate baseline. Candidate updates require an explicit reason and cannot overwrite the `0.2.0-rc.1` evidence.
- Added dependency lockstep, integrity reporting, and CI gates. The source candidate currently exposes 39 inherited Providers plus one CoreMind-native entry.

### Changed

- Aligned the three critical runtime dependencies to one exact version family and removed cross-version tool bridges.
- Adapted Session persistence to the versioned repository interface while preserving the `session.dir/<id>.jsonl` public path and explicit corrupt-file failure semantics. Backup-backed idempotent migration is delivered by the later alpha.2 candidate.
- Added the eighteenth capability module, Runtime Dependency Adapters, with tests, bilingual README/GUIDE/SOP documents, a Skill, examples, and migration guidance.

### Compatibility and rollback

- Config v2, Protocol v1, RunOutcome, permission, Checkpoint, and recovery semantics are unchanged.
- Any unadaptable message, tool, usage, error, or Session drift requires a whole-family rollback; mixed versions are not supported.

## 0.2.0-rc.1 — 2026-08-09

### Added and fixed

- Runtime, ChatSession, and CLI now return one terminal result contract for success, failure, pause, abort, timeout, and budget exhaustion. CLI exit codes are stable and JSONL ends with `run_result`.
- `--print` and `--json-events` are mutually exclusive so plain text cannot contaminate automation output.
- Custom tools must declare structured effects. Permission checks recurse into nested paths and URLs; reject absolute-path, drive, UNC, directory-link, and built-in-name escapes; and fail closed for undeclared effects under restrictions.
- Windows host-shell execution now has an explicit three-part opening gate: full mode, open workspace access, and allowed network must all be selected; every other combination fails closed.
- TUI approvals show effects, complete targets, and reasons first; long bodies are summarized and credential fields are redacted.
- Checkpoints store the post-tool file fingerprint and refuse restore when a later user or concurrent edit would be overwritten.
- The Python SDK now closes its Worker immediately when initialization or tool registration fails, preventing orphan processes from holding temporary directories open.
- All eight public npm packages now enforce release-file allowlists, test-artifact rejection, publint, type resolution, and clean-project installation. The CLI tarball no longer contains `.test.tsx` declarations or source maps.
- Candidate source ZIPs are generated through a temporary Git index without changing the real staging area. Internal plans, run state, caches, credentials, and workstation paths are rejected. ZIP inspection and extraction now use a cross-platform library with path-traversal rejection instead of relying on operating-system-specific `tar` support for ZIP files; clean installation, build, contract checks, and CLI startup remain mandatory.
- The phase-one source boundary removes a disposable phase-two Web placeholder and records local agent settings, internal plans, run data, caches, build output, and that prototype directory in `.gitignore`; CLI, SDK, Runtime, examples, and contribution materials remain intact.
- The Python wheel now passes manifest, Twine, clean virtual-environment installation, public-version parity, and bundled Worker startup gates. The stale SDK `__version__` value was corrected.
- Windows/Linux CI now runs the complete suite three consecutive times and enforces non-decreasing measured coverage. Platform-specific security tests use separate repository floors while critical Runtime modules retain shared strict floors. Remaining gaps to 80% repository and 90% critical-module branch targets are reported instead of being presented as achieved. Windows shell discovery now uses injectable, cross-platform deterministic cases. Real host-shell integration runs in a single-worker Project after normal parallel projects finish, with a dedicated 60-second outer Harness for first-process startup on hosted Windows; ProcessRunner tests verify product timeout semantics separately, without changing Runtime budgets. Property tests use fixed seeds and dedicated security-branch regressions so Runner capabilities and random samples cannot change coverage for the same commit.
- The unified release workflow now explicitly dispatches bilingual documentation deployment from `main` after the GitHub Release succeeds. Manually created releases retain the event fallback, avoiding missing Pages updates caused by workflow-token event suppression or Tag-ref deployment.
- Added the public `loop` configuration with optional planning, execution, verification, repair, iteration and repair limits, repeated-action detection, and failure or exhaustion policies. `workflow` and `loop` are explicitly mutually exclusive.
- Added a versioned state-machine adapter hidden behind `LoopController`. Every stable state persists, pause-resume and cancellation retain consistent terminal meaning, and the internal dependency does not leak into configuration, protocol, or SDK contracts.
- A failed verification must repair, pause, or fail; success requires a later passing verification. TUI, headless CLI, TypeScript SDK, and Python SDK share ordered Loop states and RunOutcome.
- Confirmed transient provider or network errors use one bounded retry policy. Approval denials, security denials, invalid arguments, and deterministic business failures do not retry blindly. Exhausted Workflow retries now return `retry_exhausted` instead of accepting a known-bad output.
- Tool calls now record `started`, `committed`, or `unknown` effect receipts. Resume does not replay completed steps or committed effects, while unknown effects require human reconciliation.
- Context compaction failures emit `context_compaction_failed`. Deterministic summaries preserve goals, constraints, permissions, modified files, test status, and next steps.
- Added the bilingual Verified Repair Loop golden example with deterministic first-failure, repaired-success, pause-resume, and exhaustion paths, bringing the total to five golden examples.
- Current candidate coverage is 72.82% lines, 70.80% statements, 80.32% functions, and 63.30% branches on Windows, and 73.26% lines, 71.19% statements, 81.00% functions, and 63.23% branches on Linux. ToolPolicy branches are 86.23%, Host Shell branches are 70.58%, LoopController branches are 100%, LoopRunner branches are 92.4%, and Checkpoint branches are 75.4%. The generic fallback uses the per-metric minimum of the two officially supported platforms.
- Added `ProcessRunner` for cross-platform command-plus-argument execution with streaming output, timeout, cancellation, output limits, and controlled environment variables. Explicit environments are never re-merged with host secrets. Host-shell execution now also treats the caller-supplied minimal environment as authoritative instead of allowing the tool execution context to replace it.
- Added read-only `GitAdapter` status/diff/log tools and unified diffs with input, output, complexity, and path limits. Arbitrary Git subcommands and repository mutations are intentionally unavailable.
- Windows host-shell selection now excludes unusable system relays, discovers a real Git Bash installation when available, and retains the policy that full mode, open workspace access, and allowed network must all be selected.
- Evaluation schemaVersion 2 adds outcome, trajectory, command, file, diff, state, and response graders. Dirty-worktree preservation, protected files, allowed paths, and final tests can now contribute to release evidence.
- Added TypeScript and Python real-defect repositories: deterministic offline evaluation passes 2/2, and five live-model runs per language pass capability and safety 5/5 with consistent trajectories, final tests, diffs, and review conclusions.
- Added property tests for paths, permissions, terminal outcomes, cancellation, and repeated actions. Expected test failures and non-reversible process warnings are no longer misclassified as security findings.
- Increased the capability-module catalog to 17 with a bilingual Coding Agent README, SOP, guide, Skill, and examples.
- The release-candidate version synchronizer aligns the root manifest, eight npm packages, exact internal dependencies, lockfile, and Python PEP 440 metadata. The current candidate is npm `0.2.0-rc.1` / Python `0.2.0rc1`.
- Release Please prepares a draft release PR only. A unified workflow builds npm tarballs, the wheel, and an independent source ZIP once from a clean tag, publishes npm/PyPI through protected OIDC environments, and creates SHA-256 plus GitHub build attestations.
- The Python release toolchain uses the available, non-yanked `build==1.5.0`. Workflow contracts reject the withdrawn version, and every tool-version change must rerun wheel and artifact gates.
- Every GitHub Action is pinned to a verified full commit SHA and maintained weekly by Dependabot together with npm and Python dependencies. Every artifact-consuming job independently verifies SHA-256 before use.
- Added a P01-P20 RC matrix. P01-P19 require both broad suites and per-case test anchors, while P20's real Windows/Linux TTY evidence must bind to the same version and commit.
- Added repository-wide Markdown auditing for strict UTF-8, local links, and the documentation identifier boundary across more than 350 project files while explicitly excluding dependencies, caches, and build outputs.
- Local `.scratch` remains reserved for acceptance evidence and isolated tool environments and is excluded from Git, static checks, and artifacts so third-party temporary files cannot contaminate repository gates.
- Credential fields, bodies, command secrets, and URL secrets are redacted before Trace and RunState persistence while paths and non-sensitive test commands remain available to audit and trajectory graders.
- Added a regression test that requires two consecutive tool-call results to feed back before the agent can finish, so P02 is no longer represented by a single tool call.
- The long-running Runtime test project explicitly uses a 15-second harness limit above the product's longest 10-second controlled-process timeout, while CLI subprocess tests retain 30 seconds. Project-local configuration prevents Vitest multi-project mode from falling back to its five-second default and failing before the real outcome on loaded runners; runtime budgets are unchanged.
- Live Provider certification now requires at least three context-preserving turns and validates all five checks plus the CoreMind version before writing evidence; the generated matrix also rejects versionless ledgers and displays the certified version. `alibaba-model-studio/qwen-plus` has been recertified against `0.2.0-rc.1` with redacted summary-only evidence.
- `doctor <config-file>` now checks the configured `provider.apiKeyEnv` before any generic credential list, preventing false failures caused by unrelated Providers; it also recognizes the Alibaba entry's default variable when the field is omitted.

## 0.2.0-beta.2 — 2026-08-08

### Fixed

- Full-screen TUI now recognizes `/abort` during generation instead of silently ignoring it while busy.
- A run where every tool request is denied and no tool succeeds now returns `paused` instead of incorrectly reporting success.
- `run` and `chat` now fail clearly with guidance when `--session` is used without `session.enabled: true`.

## 0.2.0-beta.1 — 2026-08-08

### Added

- Config v2 and Protocol v1 with aligned TypeScript and Python runtime semantics.
- A bounded execution loop with budgets, permissions, traces, run state, checkpoints, recovery, and quality gates.
- CLI/TUI commands for project creation, execution, chat, checks, evaluation, diagnostics, and templates.
- Sixteen capability modules and four golden examples with bilingual learning and operating material.
- A bilingual documentation site, community governance, issue/PR templates, and npm/PyPI preflight checks.
- Thirty-eight configurable provider entries and an evidence-based certification matrix; Alibaba Cloud Model Studio `qwen-plus` passed all five live checks.
- OS-level Linux shell isolation with networking denied, workspace-only writes, and fail-closed behavior.

### Security and compatibility

- Production dependencies have zero known audit findings.
- Known documentation dev-server risks are isolated by removing server commands, allowing static builds only, and enforcing an expiring risk policy.
- Phase one does not provide Linux-equivalent shell isolation on Windows; macOS is not yet officially supported.

### Upgrade notes

This is a beta upgrade from `0.1.0-alpha.2` to the new public contracts. Regenerate project configuration and run `coremind check`; do not assume Alpha configuration, result fields, or recovery state can be reused unchanged.
