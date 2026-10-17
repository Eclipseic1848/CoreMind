# Testing Guide

Review `coremind.yaml`, `src/search-tool.ts`, and its imports first. After accepting execution with host privileges, use the commands below with `--trust-project-code`. Non-TTY runs without this flag reject before import; TTY users may omit it and confirm each load.

Code-loading trust and tool permissions are separate: the flag does not bypass `ask` approval. Only reviewed local-mock CI that needs to skip tool approval may separately add `--permission full`; that option cannot approve code loading. These examples use local mocks and do not certify a real provider.

1. `coremind check coremind.yaml`。
2. Run the offline happy path。
3. Run at least one failure from FAILURES。
4. `node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml --trust-project-code`。
5. Verify exit code, RunOutcome, tool counts, approvals, trace, and checkpoints。
