# Release Candidate Acceptance Guide

The current acceptance target is the `1.1.0` release line. Neither the historical `0.7.0` network exception nor the `0.7.1` offline promotion applies; this version requires every strict check. Live Release and registry pages and same-commit qualification evidence determine public availability; passing source CI does not establish publication.

This guide validates the CLI/TUI, headless CLI, TypeScript SDK, Python SDK, and artifacts from one candidate commit. Automated tests, real terminals, and a live provider are independent evidence and cannot substitute for one another. The maintainer network exception for `0.7.0` must be recorded separately as waived and must never be presented as a live-provider success.


[简体中文](RC-ACCEPTANCE.zh-CN.md)


## Automated matrix

Run at the candidate repository root:

```powershell
npm run acceptance:rc
```

The command runs the full Node suite, Python SDK/real Worker tests, synchronized-version preflight, and all eight npm packages through content checks, publint, type resolution, and clean-project installation, plus wheel content and clean-install checks. P01-P19 are also bound to explicit test files and test titles. A missing evidence anchor fails the RC even when the broad test suite exits successfully.

Run `npm run baseline:check` before the RC matrix. It rebuilds every public package before comparing the frozen type contracts; stale `dist` output is not accepted as evidence that source contracts are unchanged.

| Case | Acceptance target | Entry paths |
|---|---|---|
| P01 | Plain response and complete terminal outcome | TUI, headless CLI, both SDKs |
| P02 | Consecutive tool-result feedback | TUI, headless CLI, both SDKs |
| P03 | Denial with zero side effects in the batch and later workflow steps | TUI, headless CLI, both SDKs |
| P04 | Partial success cannot hide a denial | TUI, headless CLI, both SDKs |
| P05 | Path escape fails closed | Headless CLI, both SDKs |
| P06 | Network denial cannot be bypassed | Headless CLI, both SDKs |
| P07 | Complete approval target and risk display | TUI, headless CLI |
| P08 | Consistent abort and timeout outcomes | TUI, headless CLI, both SDKs |
| P09 | Checkpoint conflicts preserve user edits | TUI, headless CLI, both SDKs |
| P10 | Stable Session and RunState recovery | TUI, headless CLI, both SDKs |
| P11 | Exhausted retry cannot return success | TUI, headless CLI, both SDKs |
| P12 | Bounded verify-repair-verify convergence | TUI, headless CLI, both SDKs |
| P13 | No-progress threshold stops execution | Headless CLI, both SDKs |
| P14 | Minimal TypeScript defect repair | Headless CLI, TypeScript SDK |
| P15 | Minimal Python defect repair | Headless CLI, Python SDK |
| P16 | Existing dirty-worktree content is preserved | Headless CLI, both SDKs |
| P17 | Credentials, bodies, and command secrets stay out of Trace/RunState | TUI, headless CLI, both SDKs |
| P18 | npm tarball contents and entries | Artifacts |
| P19 | Python wheel contents and Worker | Artifacts |
| P20 | Real Windows and Linux pseudoterminals | TUI |

## 1.1.0 feature rechecks and compatibility boundaries

Verify these journeys against the same candidate version, commit, and actual artifacts. They supplement P01-P20 and do not replace live Provider, both-platform, or post-publication public reinstall evidence:

- Standard `SKILL.md` indexing precedes explicit `load_skill` delivery of the frozen body. Cold recovery uses the original snapshot, without rereading changed source files or granting permissions.
- `/steer` and `/follow-up` take effect within one Run. Five-state control receipts stay separate from input claim/completion facts for actual Turns, and control bodies cannot answer a pending approval.
- Local MCP stdio starts only after permission and budget admission. Real tool results, cancellation, process settlement, and unknown effects retain the existing execution contract.
- HTTP MCP uses only the fixed target and exact authorized resource URIs. Credentials stay out of public events and Facts, resource contents cannot trigger arbitrary host-file reads, and Child Runs inherit no MCP authority.
- Explicit OAuth login, cancel, exit, and logout remain controlled, with independent real loopback-callback and socket-settlement evidence. A local authorization fixture does not certify external interoperability.
- Explicit Config v3 `deferred` Chinese/English lexical discovery, declaration generation, and durable selections rebuild from authoritative facts. Installation applies on subsequent requests; deny, approval, and budget checks remain active.
- Terminal approvals, durations, results, and Effects bind to actual Run/Agent/Step/Call identity. Real-entry regressions cover stored/blocked Artifacts, coalesced Chinese input, grapheme deletion, paste-as-draft, and waiting for exit settlement. Missing results cannot become success.

Config v2, default or explicit `direct`, and Protocol v1 remain compatible; `deferred` never upgrades old configuration automatically. New capabilities require matching SDK and bundled Worker support, with matching Schema fingerprints for Protocol v2. Minimum requirements remain Node.js ≥ 22.19 and Python ≥ 3.10 for the Python SDK. Record actual validation environments separately; a supported minimum is not proof that this run exercised that version. Skill loading, discovery, and recovery cannot expand existing permissions; unknown effects require human reconciliation. Global paired performance gains are not certified.

## P20 real pseudoterminal

Each release candidate must start the real CLI/TUI process inside an operating-system PTY or ConPTY on Windows and Linux and send actual keyboard input to that process. Ordinary CI logs, component render snapshots, piped stdin, and another platform's result are not substitutes. Run:

```powershell
npm run acceptance:tty
```

CI executes this command on both target platforms and uploads version- and commit-bound evidence artifacts. The release workflow downloads and validates both artifacts. If the script cannot start the platform pseudoterminal, terminal rendering is abnormal, or users report a real-experience discrepancy, fall back to manual terminal acceptance instead of skipping P20.

Each platform must confirm `launch`, `help`, `approval-deny`, `approval-allow`, `abort`, `session-resume`, `checkpoint-diff-restore`, `streaming`, `status`, and `exit`. For `approval-deny`, deny the first write request and confirm that the same run opens no further approval, creates no file, and returns `paused`. The P03 automated anchor separately proves that a sequential workflow saves no output for the denied step and starts no later step.

The following control checks are also required on both platforms:

- `control-tui`: `/steer` and `/follow-up` take effect within the same Run through the TUI.
- `control-readline`: both control commands take effect within the same Run through readline.
- `control-approval-isolation`: `y` and `n` in control bodies do not answer the pending approval; only explicit approval permits the write.
- `draft-explicit-send`: ordinary input remains a visible draft while busy and is sent only after explicit confirmation when the run finishes.
- `control-input-facts`: each control has a distinct identity, and durable input claims and completions bind to actual Turns. An `applied` receipt cannot replace consumption evidence.

The script generates evidence from the [Windows template](evidence/rc-tty-windows.example.json) or [Linux template](evidence/rc-tty-linux.example.json) under `.scratch/rc-evidence/`. Version and commit must match the candidate, `evidenceLevel` must be `automated-real-tty`, and all fifteen checks must be `true`. `.scratch` stays outside Git to avoid a commit-SHA self-reference. Archive both JSON files with the workflow run identifier, without business content or secrets.

The existing [Windows TUI maintainer acceptance guide](WINDOWS-TUI-MAINTAINER-ACCEPTANCE.zh-CN.md) records historical manual experience evidence for `0.3.0-rc.2`. `0.3.0` received a separate final maintainer acceptance run against the exact candidate artifact; later candidates still require independent acceptance. Historical manual results and the automated evidence in this section cannot substitute for one another.

Then run:

```powershell
npm run acceptance:rc -- --require-manual
```

An identity mismatch, missing check, malformed file, or either absent platform fails the command.

## Live provider

P01-P20 do not replace the live-provider release recheck. With approved data and a local environment variable, run:

```powershell
npm run providers:certify
```

Certification covers seven checks: streaming, tool calls, structured results, multi-turn state, abort, error mapping, and long context. Stop when the account lacks service entitlement, permissions, a valid credential, or a successful live request. Never switch models or providers silently, and do not present historical evidence as a current recheck.

For `0.7.0` only, Issue #113 records a one-time timeout decision bound to strict run `33582995518` and the fixed Runtime digest. It does not update the certification ledger. The separate simplified `0.7.1` decision is recorded in the SOP; other versions retain the strict live-provider requirement.

## Completion

The RC is complete only when P01-P19 and their evidence anchors pass, both P20 files bind to the same version and commit, one provider passes the strict recheck bound to this version, final commit, and Runtime digest without a historical exception, both platform gates pass, and the final repository-wide Markdown audit passes. The fixed bilingual Release body must also be reviewed for meaning; its unique `{{RELEASE_COMMIT}}` receives the verified commit SHA, creation uses `--notes-file`, and an existing-body conflict stops recovery without aggregating PR titles or overwriting the body. Tagging and publishing still follow the [Release SOP](README.en.md).
