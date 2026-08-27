# Source and Community Contribution Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
npm run build
npm run baseline:check
npm run check
npm run test:engineering
npm run test:stability
npm run test:coverage
npm run docs:build
npm run docs:audit
npm run acceptance:rc
npm run release:preflight -- --allow-dirty
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Record Windows and Linux results separately; never mark an unexecuted platform as passed.
6. PR/main first passes `Engineering CI` without live credentials; an offline candidate rehearsal cannot publish. An RC requires a manually selected `strict-provider` run plus same-commit `Candidate qualified`, Engineering CI, both-platform TTY, and provider artifacts.
7. Confirm workflows contain no movable Action tags, and require every Dependabot upgrade pull request to pass the complete gate.
8. If `baseline:check` fails, distinguish a regression from an approved contract change. Do not update the baseline without migration, rollback, and an explicit reason.

Return to the [English guide](../../../docs/modules/contribute-coremind/GUIDE.en.md).
