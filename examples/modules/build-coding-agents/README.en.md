# Coding Agent Module Example

This module includes two real defect fixtures that run in fresh temporary Git repositories:

- [TypeScript discount defect](../../coding-evals/typescript-defect)
- [Python tax defect](../../coding-evals/python-defect)

## Deterministic verification on Windows

```powershell
npm run build
npm run test:coding-evals
```

Expected result: both cases pass. Each observes one initial target-test failure, applies one minimal repair, and passes target plus full regression tests. `user-notes.txt` and the protected configuration or environment example remain unchanged.

## Live-model verification

Live-model runs incur cost and send the fixture code externally, so obtain data-egress authorization and configure the key first. Maintainers may run `npm run eval:coding-real -- --repetitions 5`; ordinary projects do not need it in their daily unit-test suite.

See the [English guide](../../../docs/modules/build-coding-agents/GUIDE.en.md) and [example overview](../../coding-evals/README.en.md) for the full procedure.
