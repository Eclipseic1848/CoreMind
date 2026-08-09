# Testing Guide

1. Run `coremind check coremind.yaml`.
2. Run the offline happy path.
3. Exercise pause-resume and exhaustion from `FAILURES.en.md`.
4. Run `node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`.
5. Verify exit code, RunOutcome, ordered Loop states, trace, effect receipts, and checkpoints.
