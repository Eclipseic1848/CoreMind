# Contract Review Agent SOP / 合同审核 Agent

1. Read requirements and architecture.
2. Start the offline provider and confirm no real secret is used.
3. Run coremind check first.
4. Run the happy path and preserve RunOutcome/Trace.
5. Run the failure path and confirm it never masquerades as success.
6. Run automated tests and evaluation.
7. Require owner approval before using real data or a real provider.

Stop for unconfirmed rules, access outside the workspace, non-reversible side effects, missing real credentials, or a failed security gate.
