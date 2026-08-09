# Changelog

## Unreleased - Release Candidate engineering

- Added Release Please draft-PR preparation, synchronized npm/Python version tooling, and immutable same-tag artifact identity checks.
- Added a P01-P20 RC matrix with test-evidence anchors and version/commit-bound Windows/Linux TTY evidence.
- Added repository-wide Markdown auditing, trusted npm/PyPI publishing, one-build artifact reuse, SHA-256 manifests, and GitHub build attestations.
- Pinned all external Actions to verified full commit SHAs, added weekly Dependabot maintenance, and required checksum verification in every artifact-consuming job.

## Unreleased - Batch 6B

- Added npm artifact allowlists, publint and type-resolution checks, and a clean tarball installation test for every public workspace.
- Added Python wheel content, Twine, clean virtual-environment installation, public-version parity, and bundled Worker startup gates.
- Added a temporary-index source ZIP gate that rejects internal/runtime artifacts and verifies clean installation, build, module contracts, docs contracts, and CLI startup without changing the real Git index.
- Added three-run Windows/Linux stability CI, measured coverage floors that cannot decrease, and workflow contracts for release-triggered documentation deployment.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Source and Community Contribution.
