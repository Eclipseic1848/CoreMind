# Testing Guide

1. `coremind check coremind.yaml`。
2. Run the offline happy path。
3. Run at least one failure from FAILURES。
4. `node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。
5. Verify exit code, RunOutcome, tool counts, approvals, trace, and checkpoints。
