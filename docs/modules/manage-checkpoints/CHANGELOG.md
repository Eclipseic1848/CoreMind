# Changelog

## 0.2.0-rc.1 - 2026-08-09

- Checkpoints now record the expected post-tool file fingerprint.
- Restore detects later user or concurrent edits and fails with `checkpoint_conflict` instead of overwriting them.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Checkpoints, Diffs, and Restore.
