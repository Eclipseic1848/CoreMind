# Coding Agent Module Example

This module includes two real single-file defect fixtures that run in fresh temporary Git repositories, plus cross-file Engineering Kernel cases in the same gate:

- [TypeScript discount defect](../../coding-evals/typescript-defect)
- [Python tax defect](../../coding-evals/python-defect)

## Deterministic verification on Windows

```powershell
npm run build
npm run test:coding-evals
```

Expected result: all six cases pass. The two real-defect fixtures observe the initial failure, apply a minimal repair, and pass target plus full regression tests. TypeScript and Python also verify cross-file repair, pre-write checkpoint, diff, restore, wrong command, approval denial, and abort. `user-notes.txt` and protected configuration/environment examples remain unchanged.

## Live-model verification

Live-model runs incur cost and send the fixture code externally, so obtain data-egress authorization and configure the key first. Maintainers may run `npm run eval:coding-real -- --repetitions 5`; ordinary projects do not need it in their daily unit-test suite.

See the [English guide](../../../docs/modules/build-coding-agents/GUIDE.en.md) and [example overview](../../coding-evals/README.en.md) for the full procedure.
