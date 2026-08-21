# Source and Community Contribution Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
npm run build
npm run baseline:check
npm run check
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
6. An ordinary feature branch may use `npm run release:preflight -- --allow-dirty --defer-provider-certification` to defer current-Runtime certification. A complete RC must return to strict preflight and run `npm run acceptance:rc -- --require-manual`; do not continue without both same-commit TTY files and the current live-provider result.
7. Confirm workflows contain no movable Action tags, and require every Dependabot upgrade pull request to pass the complete gate.
8. If `baseline:check` fails, distinguish a regression from an approved contract change. Do not update the baseline without migration, rollback, and an explicit reason.

Return to the [English guide](../../../docs/modules/contribute-coremind/GUIDE.en.md).
