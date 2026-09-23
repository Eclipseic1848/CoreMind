# Data Analysis Agent

Register a callable through the Python SDK, summarize CSV data deterministically, and write the artifact inside the workspace.

## Offline run

Use separate terminals for the mock provider and the example. Enter this example directory and set `GOLDEN_MOCK_API_KEY=offline` in both terminals (PowerShell: `$env:GOLDEN_MOCK_API_KEY="offline"`).

1. Build at the repository root：`npm run build:python-worker`。
2. Enter this directory and set the local-mock environment variable：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. Start the provider：`node ../_shared/mock-provider.mjs data 8813`。
4. Run in another terminal：`python src/main.py`。
5. Run evaluation：`python -m unittest discover -s tests -p "test_*.py"`。

## Expected evidence

Returns rows=3 and total=300, then writes East and South region totals to artifacts/summary.json.

- Configuration：[coremind.yaml](coremind.yaml)
- Scenarios：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[English](SOP.en.md)
- Failures and repairs：[English](FAILURES.en.md)

This example uses mock data only. A real provider must use apiKeyEnv and requires authorization before data egress.
