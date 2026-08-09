# Verified Repair Loop

Generate a candidate, verify it independently, repair within bounds, and demonstrate pause-resume and exhaustion outcomes.

## Offline run

1. Build at the repository root: `npm run build:python-worker`.
2. Enter this directory and set the local-mock environment variable: PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`; Linux `export GOLDEN_MOCK_API_KEY=offline`.
3. Start the provider: `node ../_shared/mock-provider.mjs loop 8815`.
4. Run in another terminal: `node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "repair the candidate"`.
5. Run evaluation: `node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`.

## Expected evidence

The first verification returns FAIL, repair produces candidate-fixed, and the next verification returns PASS; tests also cover pause-resume and exhaustion.

- Configuration: [coremind.yaml](coremind.yaml)
- Scenarios: [evals/scenarios.yaml](evals/scenarios.yaml)
- SOP: [English](SOP.en.md)
- Failures and repairs: [English](FAILURES.en.md)

This example uses mock data only. A real provider must use `apiKeyEnv` and requires authorization before data egress.
