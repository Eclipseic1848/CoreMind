# CLI and TUI Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
coremind providers
coremind create my-agent --template translator --language typescript --provider alibaba-model-studio
coremind check my-agent/coremind.yaml
coremind eval my-agent/coremind.yaml
coremind run my-agent/coremind.yaml --prompt "acceptance" --json-events
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Confirm the final JSONL line is `run_result`, then verify success `0`, failure `1`, pause `2`, budget `3`, timeout `124`, and abort `130`.
6. Pass `--print --json-events` together and confirm the CLI fails before model execution with exit code `1`.
7. Run `/status`, `/artifacts`, and `/context` in the TUI, then compare the final JSONL `snapshot` for matching recovery, evaluation, artifact, and compaction fields.
8. Submit ordinary Enter input while the TUI is busy and confirm it is not queued into a later turn; verify `/abort` and `/children` remain immediately available.

Return to the [English guide](../../../docs/modules/operate-coremind-cli/GUIDE.en.md).
