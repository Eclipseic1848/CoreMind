---
name: operate-coremind-cli
description: "Operate or diagnose CoreMind create, run, chat, check, eval, doctor, and templates, including explicit Loop status and safe pause-resume. Use for CLI, TUI, readline, automation, exit-code, or recovery work."
---

# CLI and TUI

1. Read [the module contract](../../docs/modules/operate-coremind-cli/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/operate-coremind-cli/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. For automation, require the stable exit code and the final JSONL `run_result`; keep diagnostics on stderr, reject `--print` plus `--json-events`, and never infer success from prose.
6. For TUI approval, verify the effect, complete target, reason, and redacted argument summary remain visible with long content.
7. Inspect RunOutcome, Trace, budgets, approvals, and checkpoints. Treat a fluent answer without evidence as unverified.
8. For explicit Loops, compare ordered state events across TUI, readline, and JSONL; resume the same run ID without replaying completed steps or committed effects.
9. Compare TUI `/status`, `/artifacts`, and `/context` with the final JSONL `snapshot`; recovery, evaluation, artifact, cache, and compaction evidence must match.
10. While a TUI run is busy, verify ordinary Enter input is rejected instead of queued into a later turn, while `/abort` and `/children` remain immediately available.
11. Run the tests listed in [module.yaml](../../docs/modules/operate-coremind-cli/module.yaml) and `npm run check:modules`.
12. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint、Effect Receipt 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
