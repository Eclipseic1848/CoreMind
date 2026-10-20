# Changelog

## 1.3.0 - 2026-10-20

- 修复 `parallel` 首次失败或暂停后的同组步骤取消与收尾，保留首个错误，并在 Run 结束后拒绝新模型调用；已开始操作的收据保留，取消不等于回滚，全成功仍按声明顺序聚合（#325）。
- Fix sibling cancellation and settlement after the first `parallel` failure or pause, preserve the first error, and reject new model calls after the Run ends. Operations already started retain their receipts; cancellation is not rollback, and all-success results still aggregate in declaration order (#325).
- 修复 Workflow `prompt`/`call` 步骤输出边界：同一 Session 的历史仍作为模型上下文，步骤输出、`saveAs`、后续插值和 transcript 只包含本步骤新增的 assistant 文本（#327）。
- Fix Workflow `prompt`/`call` step output boundaries: the same Session history remains model context, while step output, `saveAs`, subsequent interpolation, and transcript contain only assistant text newly produced by that step (#327).

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

## 0.7.1 - 2026-09-03

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.7.0 - 2026-08-29

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the stable release.

## 0.3.2 - 2026-08-26

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.1 - 2026-08-21

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0 - 2026-08-13

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.2 - 2026-08-12

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.2.0-rc.1 - 2026-08-09

- Added the public `loop` schema for planning, execution, verification, repair, bounded iterations, no-progress detection, pause, and exhaustion behavior.
- Added a hidden state-machine adapter, stable snapshots, cancellation propagation, and deterministic event-order contracts.
- Added transient-error classification, explicit retry exhaustion failure, and effect receipts for safe resume decisions.
- Added a bilingual verified-repair golden example covering injected failure, pause-resume, and exhaustion.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Workflows and Bounded Loops.
