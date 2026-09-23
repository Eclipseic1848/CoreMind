# FAQ and Order Assistant

Answer status questions from offline order data and report missing orders without fabrication.

## Offline run

Use separate terminals for the mock provider and the example. Enter this example directory and set `GOLDEN_MOCK_API_KEY=offline` in both terminals (PowerShell: `$env:GOLDEN_MOCK_API_KEY="offline"`).

1. Build at the repository root：`npm run build:python-worker`。
2. Enter this directory and set the local-mock environment variable：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. Start the provider：`node ../_shared/mock-provider.mjs order 8811`。
4. Run in another terminal：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "查询订单 A-100"`。
5. Run evaluation：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。

## Expected evidence

Outputs that A-100 is paid for 299 and records one lookup_order approval and tool call.

- Configuration：[coremind.yaml](coremind.yaml)
- Scenarios：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[English](SOP.en.md)
- Failures and repairs：[English](FAILURES.en.md)

This example uses mock data only. A real provider must use apiKeyEnv and requires authorization before data egress.
