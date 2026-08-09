# CoreMind Changelog

This file records user-facing changes. Versions follow Semantic Versioning; beta releases may include explicitly documented interface changes.

[简体中文](CHANGELOG.md)

## Unreleased

### Added and fixed

- Runtime, ChatSession, and CLI now return one terminal result contract for success, failure, pause, abort, timeout, and budget exhaustion. CLI exit codes are stable and JSONL ends with `run_result`.
- `--print` and `--json-events` are mutually exclusive so plain text cannot contaminate automation output.
- Custom tools must declare structured effects. Permission checks recurse into nested paths and URLs; reject absolute-path, drive, UNC, directory-link, and built-in-name escapes; and fail closed for undeclared effects under restrictions.
- Windows host-shell execution now has an explicit three-part opening gate: full mode, open workspace access, and allowed network must all be selected; every other combination fails closed.
- TUI approvals show effects, complete targets, and reasons first; long bodies are summarized and credential fields are redacted.
- Checkpoints store the post-tool file fingerprint and refuse restore when a later user or concurrent edit would be overwritten.
- The Python SDK now closes its Worker immediately when initialization or tool registration fails, preventing orphan processes from holding temporary directories open.
- All eight public npm packages now enforce release-file allowlists, test-artifact rejection, publint, type resolution, and clean-project installation. The CLI tarball no longer contains `.test.tsx` declarations or source maps.
- Candidate source ZIPs are generated through a temporary Git index without changing the real staging area. Internal plans, run state, caches, credentials, and workstation paths are rejected before clean installation, build, contract checks, and CLI startup.
- The Python wheel now passes manifest, Twine, clean virtual-environment installation, public-version parity, and bundled Worker startup gates. The stale SDK `__version__` value was corrected.
- Windows/Linux CI now runs the complete suite three consecutive times and enforces non-decreasing measured coverage. Remaining gaps to 80% repository and 90% critical-module branch targets are reported instead of being presented as achieved.
- A Release event now dispatches documentation deployment from `main`, avoiding a protected Pages environment rejection before a Tag-ref job can start.
- Added the public `loop` configuration with optional planning, execution, verification, repair, iteration and repair limits, repeated-action detection, and failure or exhaustion policies. `workflow` and `loop` are explicitly mutually exclusive.
- Added a versioned state-machine adapter hidden behind `LoopController`. Every stable state persists, pause-resume and cancellation retain consistent terminal meaning, and the internal dependency does not leak into configuration, protocol, or SDK contracts.
- A failed verification must repair, pause, or fail; success requires a later passing verification. TUI, headless CLI, TypeScript SDK, and Python SDK share ordered Loop states and RunOutcome.
- Confirmed transient provider or network errors use one bounded retry policy. Approval denials, security denials, invalid arguments, and deterministic business failures do not retry blindly. Exhausted Workflow retries now return `retry_exhausted` instead of accepting a known-bad output.
- Tool calls now record `started`, `committed`, or `unknown` effect receipts. Resume does not replay completed steps or committed effects, while unknown effects require human reconciliation.
- Context compaction failures emit `context_compaction_failed`. Deterministic summaries preserve goals, constraints, permissions, modified files, test status, and next steps.
- Added the bilingual Verified Repair Loop golden example with deterministic first-failure, repaired-success, pause-resume, and exhaustion paths, bringing the total to five golden examples.
- Raised measured coverage floors to 72.31% lines, 70.37% statements, 79.66% functions, and 62.47% branches. LoopController branches are 100%, LoopRunner branches are 92.4%, and Checkpoint branches are 75.4%.
- Added `ProcessRunner` for cross-platform command-plus-argument execution with streaming output, timeout, cancellation, output limits, and controlled environment variables. Explicit environments are never re-merged with host secrets.
- Added read-only `GitAdapter` status/diff/log tools and unified diffs with input, output, complexity, and path limits. Arbitrary Git subcommands and repository mutations are intentionally unavailable.
- Windows host-shell selection now excludes unusable system relays, discovers a real Git Bash installation when available, and retains the policy that full mode, open workspace access, and allowed network must all be selected.
- Evaluation schemaVersion 2 adds outcome, trajectory, command, file, diff, state, and response graders. Dirty-worktree preservation, protected files, allowed paths, and final tests can now contribute to release evidence.
- Added TypeScript and Python real-defect repositories: deterministic offline evaluation passes 2/2, and five live-model runs per language pass capability and safety 5/5 with consistent trajectories, final tests, diffs, and review conclusions.
- Added property tests for paths, permissions, terminal outcomes, cancellation, and repeated actions. Expected test failures and non-reversible process warnings are no longer misclassified as security findings.
- Increased the capability-module catalog to 17 with a bilingual Coding Agent README, SOP, guide, Skill, and examples.
- The release-candidate version synchronizer aligns the root manifest, eight npm packages, exact internal dependencies, lockfile, and Python PEP 440 metadata. The current candidate is npm `0.2.0-rc.1` / Python `0.2.0rc1`.
- Release Please prepares a draft release PR only. A unified workflow builds npm tarballs, the wheel, and an independent source ZIP once from a clean tag, publishes npm/PyPI through protected OIDC environments, and creates SHA-256 plus GitHub build attestations.
- Every GitHub Action is pinned to a verified full commit SHA and maintained weekly by Dependabot together with npm and Python dependencies. Every artifact-consuming job independently verifies SHA-256 before use.
- Added a P01-P20 RC matrix. P01-P19 require both broad suites and per-case test anchors, while P20's real Windows/Linux TTY evidence must bind to the same version and commit.
- Added repository-wide Markdown auditing for strict UTF-8, local links, and the documentation identifier boundary across more than 350 project files while explicitly excluding dependencies, caches, and build outputs.
- Credential fields, bodies, command secrets, and URL secrets are redacted before Trace and RunState persistence while paths and non-sensitive test commands remain available to audit and trajectory graders.
- Added a regression test that requires two consecutive tool-call results to feed back before the agent can finish, so P02 is no longer represented by a single tool call.

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
