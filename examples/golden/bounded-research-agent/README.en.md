# Bounded Research Agent

Collect offline evidence within explicit tool, retry, turn, step, token, and timeout budgets, then use an isolated reviewer.

## Offline run

Use separate terminals for the mock provider and the example. Enter this example directory and set `GOLDEN_MOCK_API_KEY=offline` in both terminals (PowerShell: `$env:GOLDEN_MOCK_API_KEY="offline"`).

Review `coremind.yaml`, `src/search-tool.ts`, and its imports first. After accepting execution with host privileges, use the commands below with `--trust-project-code`. Non-TTY runs without this flag reject before import; TTY users may omit it and confirm each load.

Code-loading trust and tool permissions are separate: the flag does not bypass `ask` approval. Only reviewed local-mock CI that needs to skip tool approval may separately add `--permission full`; that option cannot approve code loading. These examples use local mocks and do not certify a real provider.

1. Build at the repository root：`npm run build:python-worker`。
2. Enter this directory and set the local-mock environment variable：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. Start the provider：`node ../_shared/mock-provider.mjs research 8814`。
4. Run in another terminal：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "是否应直接用于高影响决策" --trust-project-code`。
5. Run evaluation：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml --trust-project-code`。

## Expected evidence

Recommends a small pilot, cites S1/S2, preserves human review, and reports medium confidence.

- Configuration：[coremind.yaml](coremind.yaml)
- Scenarios：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[English](SOP.en.md)
- Failures and repairs：[English](FAILURES.en.md)

This example uses mock data only. A real provider must use apiKeyEnv and requires authorization before data egress.
