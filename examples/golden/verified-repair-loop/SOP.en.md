# Verified Repair Loop Development SOP

1. Read the [requirements](docs/requirements.en.md) and [architecture](docs/architecture.en.md). This example verifies the framework mechanisms; replace its sample rules with your accepted business rules.
2. Start the offline mock provider and confirm that the environment variable contains only the example value, with no real secret or business data.
3. Run `coremind check coremind.yaml` before the happy path.
4. Verify execute → verify → repair → verify → succeeded state order and preserve RunOutcome and trace evidence.
5. Exercise `onFailure: pause`, resume the same run ID, and confirm execute does not replay.
6. Exercise `maxRepairs: 0` and confirm the terminal reason is `loop_exhausted`, never success.
7. Run automated tests and evaluation. Replace data, rules, or the provider only after owner approval.

Stop for an unconfirmed verification rule, access outside the workspace, an unknown or irreversible effect, unavailable real credentials, or a failed security gate.
