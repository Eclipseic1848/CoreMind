# CLI and TUI Guide

## When to use it

Provide a beginner end-to-end path through create, run, chat, check, eval, doctor, and templates, observe Loop progress, and use run --resume for paused or interrupted runs with a safe boundary.

## Minimal example

```text
coremind create my-agent --template translator --language typescript
coremind check my-agent/coremind.yaml
coremind eval my-agent/coremind.yaml
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/operate-coremind-cli/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Enter `/abort` during a long response and verify that generation stops and input remains usable.
6. Set `session.enabled: true` before using `--session`; the CLI must fail clearly rather than continue silently when it is missing.
7. For an explicit Loop, compare state order across TUI, readline, and `--json-events`, then resume a pause with the same run ID.
8. With `coremind doctor coremind.yaml`, verify that credential checks follow that config's `provider.apiKeyEnv` and do not fail on unrelated Provider keys.
9. In the TUI, run `/status`, `/artifacts`, and `/context`, then verify recovery, evaluation, artifact references, and context-compaction evidence.

## Automation contract

```powershell
coremind run coremind.yaml --prompt "acceptance run" --json-events *> run-output.txt
$LASTEXITCODE
Get-Content -LiteralPath run-output.txt -Encoding utf8 | Select-Object -Last 1
```

Production scripts should redirect stdout and stderr separately; the example combines them only for manual inspection. Use `0/1/2/3/124/130` as terminal exit codes, and require the final JSONL line to parse as `type: "run_result"`. Never infer success by searching human-readable text.

Machine consumers should prefer the final `snapshot`. Compatibility fields remain at the top level, while `snapshot` is the common pure-JSON terminal envelope for CLI, Worker, and both SDKs.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
