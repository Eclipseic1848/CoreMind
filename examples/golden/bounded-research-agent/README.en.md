# Bounded Research Agent

Collect offline evidence within explicit tool, retry, turn, step, token, and timeout budgets, then use an isolated reviewer.

## Offline run

1. Build at the repository root：`npm run build:python-worker`。
2. Enter this directory and set the local-mock environment variable：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. Start the provider：`node ../_shared/mock-provider.mjs research 8814`。
4. Run in another terminal：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "是否应直接用于高影响决策"`。
5. Run evaluation：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。

## Expected evidence

Recommends a small pilot, cites S1/S2, preserves human review, and reports medium confidence.

- Configuration：[coremind.yaml](coremind.yaml)
- Scenarios：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[English](SOP.en.md)
- Failures and repairs：[English](FAILURES.en.md)

This example uses mock data only. A real provider must use apiKeyEnv and requires authorization before data egress.
