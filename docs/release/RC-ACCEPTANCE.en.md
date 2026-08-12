# Release Candidate Acceptance Guide

This guide validates the CLI/TUI, headless CLI, TypeScript SDK, Python SDK, and artifacts from one candidate commit. Automated tests, real terminals, and a live provider are independent evidence and cannot substitute for one another.

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
| P20 | Real Windows and Linux TTY | TUI |

## P20 real TTY

Run the interactive acceptance once in a real Windows terminal and once in a real Linux terminal. Ordinary CI output, pseudo-terminal snapshots, and another platform's result are not substitutes.

Each platform must confirm `launch`, `help`, `approval-deny`, `approval-allow`, `abort`, `session-resume`, `checkpoint-diff-restore`, and `exit`. For `approval-deny`, deny the first write request and confirm that the same run opens no further approval, creates no file, and returns `paused`. The P03 automated anchor separately proves that a sequential workflow saves no output for the denied step and starts no later step. Copy the [Windows template](evidence/rc-tty-windows.example.json) or [Linux template](evidence/rc-tty-linux.example.json), then save completed evidence as `.scratch/rc-evidence/rc-tty-windows.json` and `.scratch/rc-evidence/rc-tty-linux.json`. The version and commit must match the candidate, and every check must be `true`. `.scratch` stays outside Git: committing evidence that contains the candidate SHA would change that SHA and create an impossible self-reference. Archive both JSON files with the corresponding workflow run identifier in a controlled acceptance store, without business content or secrets.

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

## Completion

The RC is complete only when P01-P19 and their evidence anchors pass, both P20 files bind to the same version and commit, at least one provider passes the current live recheck, both platform gates pass, and the final repository-wide Markdown audit passes. Tagging and publishing still follow the [Release SOP](README.en.md).
