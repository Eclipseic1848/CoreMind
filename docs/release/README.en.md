# CoreMind Release SOP

The release includes eight npm packages, the Python SDK, independently versioned components, a source ZIP, a GitHub Release, and the bilingual documentation site. The manifest binds each distribution to its build, version and SHA-256.

> The 2.1.0 candidate uses 2.0.0 as its upgrade baseline. The CLI and SDKs share the candidate version; knowledge, Hindsight memory and ontology each start at 0.1.0. Qualify the Runtime alone, individual capabilities, composition and removal in a clean project. Keep the document assistant as a composition regression. Compare all thirteen public artifacts with the same release build.

[简体中文](README.zh-CN.md) · [RC acceptance](RC-ACCEPTANCE.en.md) · [Known limitations](KNOWN-LIMITATIONS.en.md) · [1.4→2.0 migration](../migrations/1.4-to-2.0.en.md) · [2.0 release notes](notes/v2.0.0.md) · [2.0-to-2.1 candidate migration](../migrations/2.0-to-2.1.en.md) · [2.1 candidate notes](notes/v2.1.0.md)

## Historical release decisions

Version `0.7.1` used the separately approved fixed artifacts from [Candidate 33838498153](https://github.com/Eclipseic1848/CoreMind/actions/runs/33838498153), retaining their original build provenance and `providerCertification: not-run`. The `0.7.0` network exception and `0.7.1` offline promotion explain historical artifacts only; neither applies to `1.0.1` or `1.2.0`. Do not restart those releases or overwrite their artifacts.

## Historical 1.4.0 release preparation and upgrade boundaries

This version includes #324–#333 framework-state protection, parallel termination, step output, Python annotations, Diff grading, v2 error identity, network cleanup, and CLI diagnostics, plus subsequent dependency-security, Windows execution, and CI failure-propagation fixes. #359–#367 add precise dependency-risk disposition, retry status boundaries, atomic task commits and phase migration, durable waits/wakes, keyed calls, session trees/branches/forks, and TS plus sync/async Python access through one Node Worker. See the [current-version changelog](../../CHANGELOG.en.md#140) and [migration guide](../migrations/1.2-to-1.4.en.md) for the complete scope.

TaskSession phase commits form a separate task fact domain; sequential Session, Run, and Workspace writes are not one atomic transaction. Model and tool work retains existing Runtime permissions, budgets, cancellation, and recovery gates. The host registers trusted definitions and owns process startup and alarms; the default Worker exposes no unregistered tasks, and Python neither transmits executable source nor creates another Runtime. A session fork creates a new identity without copying execution or authority. Rollback requires stopping writers, preserving current facts, and restoring the complete pre-upgrade backup; old SDKs cannot take over new task/session records.

[#379](https://github.com/Eclipseic1848/CoreMind/issues/379) aligns the underlying runtime dependency family on 1.5.0 and uses its official transitive versions Undici 8.12.3 and minimatch 11.0.3, removing the risk acceptances for the nine advisories recorded in [#359](https://github.com/Eclipseic1848/CoreMind/issues/359). Before publication, check the npm consumer graph without repository overrides, the Worker manifest, and production and full dependency audits. The separate development dependency risk acceptance retains its scope and original 2026-11-14 expiry. See the [security policy](../../SECURITY.en.md).

Prepare versions, documentation, engineering, and offline gates in the Release Please draft PR. After merge, freeze main and obtain strict qualification bound to the final 1.4.0 commit, Runtime/Worker, and exact artifacts. Neither 1.2.0 certification nor historical exceptions qualify this release. Unknown effects still require human reconciliation; existing Config/Protocol compatibility and capability checks remain.

## Historical 1.2.0 release line and upgrade boundaries

This release line includes unpublished 1.1 extensions and interaction capabilities, together with Session, tool-argument, model-request, custom-authentication, output-delivery, dependency-identity, duplicate Call identity, journal-processing, Python notification-consumption, project-script loading-trust, and terminal-editing improvements. Final notes and qualification must bind to the final commit. See the [changelog](../../CHANGELOG.en.md).

Config v2, omitted or explicit `direct` tools, and Protocol v1 remain compatible; `deferred` requires explicit Config v3. New features require matching SDK and bundled Worker capabilities; Protocol v2 also requires matching Schema fingerprints. Node.js ≥ 22.19 is required, and the Python SDK requires Python ≥ 3.10. Unknown effects still require human reconciliation before resume. Skill loading and tool discovery grant no new permissions. Real external authorization-server interoperability and global paired performance gains are not certified.

## Principles

- Version, commit, tag, artifact manifest, and public documentation must agree.
- Release bodies use only a fixed bilingual text reviewed for meaning. The only dynamic content is the verified full commit SHA. Never aggregate PR/commit titles or generate notes automatically; an existing-body conflict stops the release.
- TypeScript and Python ship together. The Python SDK continues to call the same Node runtime.
- Release Please only creates or updates the release PR, and the workflow then immediately and idempotently converts a newly created ready PR to draft. It never tags or publishes. Conversion leaves a brief ready window, so repository auto-merge must remain disabled and no publication side effect may depend only on a PR being ready.
- npm and PyPI use GitHub OIDC trusted publishing; the repository and workflow do not store long-lived registry tokens.
- External GitHub Actions are pinned to full commit SHAs. Dependabot opens weekly update pull requests for Actions, npm, and Python dependencies, and those updates must pass the complete gate before merge.
- Artifacts are built once. npm, PyPI, attestations, and the GitHub Release all download that same build.
- Under the general strict procedure, a failed live Provider, Windows TTY, Linux TTY, platform CI, or repository-wide Markdown audit stops publication. Historical decisions do not replace current-version strict qualification.

## One-time account configuration

Set up the protected GitHub environments `npm`, `pypi`, `pypi-knowledge`, `pypi-memory`, and `pypi-ontology`. Each deploys from main and requires maintainer approval. Configure Trusted Publishers for all eight npm packages with repository `Eclipseic1848/CoreMind`, workflow `publish-pypi.yml`, and environment `npm`. Configure the PyPI `coremind-ai` publisher with the same repository and workflow plus environment `pypi`. Allow GitHub Actions to create pull requests, keep repository auto-merge disabled, and do not configure irreversible automation that runs only because a PR is ready. The workflow filename and environment are part of the OIDC identity; renaming either requires a coordinated registry-side update and revalidation.

Before the first component releases, register their Pending Trusted Publishers in [PyPI Publishing](https://pypi.org/manage/account/publishing/). Use owner `Eclipseic1848`, repository `CoreMind` and workflow `publish-pypi.yml`. Each pending publisher uses a distinct environment.

| PyPI project | GitHub environment |
| --- | --- |
| `coremind-ai` | `pypi` (existing SDK project) |
| `coremind-knowledge-mcp` | `pypi-knowledge` |
| `coremind-memory-mcp` | `pypi-memory` |
| `coremind-ontology-mcp` | `pypi-ontology` |

Confirm the account-side registration independently of the public project endpoint. The first upload converts a pending publisher into a publisher for that project. [PyPI registration](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/) · [OIDC claim matching](https://docs.pypi.org/trusted-publishers/internals/)

## Freeze the candidate

Run the `Prepare Release Pull Request` workflow with a target such as `2.1.0`. The workflow uses Release Please's non-manifest entry so that this input directly controls version calculation, then immediately converts the created PR to draft. A failure to create or convert the PR stops candidate preparation. In that draft PR, synchronize every npm and Python version:

Before continuing, verify that a release PR actually exists for the target version and expected branch with `isDraft=true`; workflow success alone is insufficient. If none exists, first reconcile older unpublished or unsynchronized release PRs; never skip the draft and proceed directly to qualification.

```powershell
npm run release:sync-version -- 2.1.0
npm run release:preflight -- --allow-dirty
```

### Freeze and review the Release body

Review `docs/release/notes/v2.1.0.md`, both changelogs, migration from 2.0 and the scope of the actual tests. The reviewed body has exactly one `{{RELEASE_COMMIT}}` and the renderer injects only the verified 40-character commit for the tag.

Before freezing, inspect the actual npm tarballs and Python wheels for the instructions users will see in the registries. Review root and bundled bilingual template READMEs and wheel `METADATA` descriptions. Check that current install commands match the package versions and that public documentation links resolve. Correct bundled instructions before publishing because repository documentation updates leave uploaded artifacts unchanged.

Validate the template and Tag/HEAD identity before any public Registry or Release write. Recheck the artifact manifest in the Release stage and create the Release from the fixed output file through `gh release create --notes-file`. Missing, empty, mismatched, or unknown template fields stop the operation without falling back to `--generate-notes`. When resuming an existing Release, compare its body with the text rendered for the same identity before uploading missing assets. Only explicit CRLF/LF and final-terminating-newline differences are allowed; a different or missing body or an unknown query result stops recovery, without automatic editing or replacement. Existing asset-hash, build-once, and recovery gates remain active. Notes control never removes real dependencies, copyrights, licenses, or NOTICE files.

Windows MCP startup uses fixed Job assets and a thin launcher while retaining the original 15-second call and 60-second connection gates. Formal publication requires strict Provider, both-platform engineering/stability/coverage/real PTY, and public download/reinstall evidence bound to the final commit and exact artifacts. Do not copy older run IDs, W/F identities, coverage, or test counts into a 2.0 conclusion.

Both-platform CI on an ordinary feature branch may explicitly use `--defer-provider-certification` on both `release:preflight` and the nested `acceptance:rc` command. This defers only the requirement that the in-development Runtime already have a live-provider certification. The mode must emit a warning, cannot be passed bare by a release operator, and cannot be enabled through an environment variable. The publication workflow first verifies an external strict-provider Artifact against the candidate commit, version, Runtime build, and bundled Worker, then uses defer internally to replace the checked-in ledger check. It verifies the final npm package digest before generating the release manifest; every other release gate remains active.

`0.7.0` has one maintainer-approved Provider network exception. Both candidate platforms passed in strict run `33582995518`, but the first `alibaba-model-studio/qwen-plus` request timed out before an HTTP response. The publication workflow accepts `--allow-provider-network-waiver` only for `v0.7.0` when the Runtime digest is unchanged, the Issue #113 decision is still valid, the original run and failed job still match, and a new both-platform offline candidate run exists for the release commit. The flag cannot be enabled through an environment variable, does not update the successful Provider ledger, and is invalid for every other version.


The synchronizer updates the root manifest, all eight public npm packages, exact internal dependencies, the lockfile, Python PEP 440 metadata, and `coremind.__version__`. Update both changelogs, READMEs, migration guidance, provider state, third-party notices, and roadmaps before marking the PR ready.

Let S identify the final main source commit and H the Runtime candidate-package SHA-256. Before any live Provider execution, obtain explicit data-egress and cost approval under the [certification SOP](../providers/CERTIFICATION.en.md), binding the Provider, model, credential source, cost ceiling, maximum duration, and this S/H. Approval or certification for an older candidate is not reusable. Engineering-only success or a skipped Provider does not establish strict qualification.

## Code, documentation, and RC gates

```powershell
npm ci
npm run build
npm run check
npm run test:stability
npm run test:coverage
npm run docs:build
npm run docs:audit
npm run security:audit
npm run acceptance:rc
```

Record concrete counts, conditional-skip reasons, coverage floors and target gaps, Python results, module contracts, golden examples, and audit results. `docs:audit` checks every project-maintained Markdown file for strict UTF-8, existing local links, and the documentation identifier boundary while excluding dependencies, caches, coverage, and build output.

P0-17 stores the maintainer's read-only `main` ruleset export and bypass actor in [`v0.7.1-main-ruleset.json`](evidence/v0.7.1-main-ruleset.json). The publication workflow separately queries the current ruleset target, mandatory rules, approval count, check names, and GitHub App integration IDs. The pull request containing that evidence must still merge through both required Engineering checks; the snapshot does not replace the controlled-PR proof.

Property tests must use repository-fixed seeds, and host-capability discovery must be exercised through injectable deterministic cases. If the same commit produces coverage drift across repeats or runners, remove the test nondeterminism before changing any floor.

The formal Candidate cancellation-stability matrix retains all 1000 fixed seeds; Engineering CI's targeted seed 4 regression cannot replace it. Keep all existing task, RPC, subprocess, settlement, and workflow timeouts. Increasing deadlines, shrinking the matrix, or rerunning unexplained failures cannot establish release qualification.

Follow the [RC acceptance guide](RC-ACCEPTANCE.en.md). P01-P19 and their evidence anchors must pass; real Windows ConPTY and Linux PTY evidence must bind to the same version and commit; and a currently authorized Provider must pass streaming, tool, structured-result, multi-turn, and error-path rechecks. The current candidate cannot reuse older release exceptions. Actual P20 JSON stays in ignored `.scratch/rc-evidence/` and is archived with the workflow run identifier; the source commit retains templates only, avoiding a commit-SHA self-reference. Finish with:

```powershell
npm run acceptance:rc -- --require-manual
```

## Merge, tag, and publish

After the final Markdown audit, mark the release PR ready. Merge only after both platform checks pass. Complete strict Candidate Qualification on the frozen main commit, with the actual `Candidate qualified` job successful and matching version, Runtime package digest, live Provider, and both-platform PTY evidence, before creating `v2.1.0` on that commit. The tag must equal the root manifest version and must never be moved or overwritten. Tag creation does not publish. After tagging, rerun strict preflight. Historical `v0.7.0` recovery keeps its dedicated network-waiver flag; no other version may use it.

For the current release, manually running `Publish CoreMind Release` checks out the tag, builds eight npm tarballs, one SDK wheel, three independent component wheels, and one source ZIP, validates exact contents and clean installs, and rejects ZIP path traversal through a cross-platform decoder before writing `release-manifest.json` and `SHA256SUMS.txt`. Every consumer independently verifies the checksum file before an isolated job creates the GitHub build attestation or protected OIDC jobs publish the exact npm artifacts and wheels. Each PyPI job publishes only the wheel for its environment. The historical `0.7.0` candidate, release, and public-reinstall stages produce top-level P0-01–P0-20, P0-01–P0-21, and P0-01–P0-22 reports; those reports remain historical evidence. Pre-releases use npm `next`; stable versions use `latest`. The GitHub Release is created with the validated fixed body through `--notes-file` only after npm, PyPI, and attestation succeed, then the release job explicitly dispatches bilingual documentation deployment from `main` through `workflow_dispatch`. The Release event route remains a fallback for releases created manually by a maintainer.

The Release attaches only the independent source ZIP, checksums, and manifest in addition to GitHub's unavoidable automatic source zip/tar.gz links. Leave `artifact_run_id` empty for the first run. That path first proves the same commit has no earlier successful Build and that the target version is explicitly absent from the GitHub Release, all eight npm packages, and PyPI; any existing or unknown state refuses a rebuild. After a partial publication or uncertain network result, pass the original publication run ID: the workflow accepts only a saved bundle from the same workflow and commit with a successful Build and matching tag, version, manifest, and checksums; it never rebuilds that continuation. Existing same-name, same-version npm, PyPI, or GitHub Release assets are skipped only when their hashes match; missing assets are uploaded and hash conflicts fail immediately. Published versions remain immutable, so conflicts require a higher repaired version.

## Public-registry verification and failure handling

Let R identify the single publication build bundle. Download all thirteen artifacts publicly from npm, PyPI, and the GitHub Release: eight npm tarballs, one SDK wheel, three component wheels, and one source ZIP. Compare every item with R's manifest and SHA-256 values, then verify all eight npm entries, the CLI, bundled Worker, basic Child Run, and extracted source-ZIP installation in clean environments. Start each installed component separately, then verify composition and removal. Maintainers should additionally verify a fresh global CLI install, create a project, run `coremind check`, and use a new Python virtual environment to verify `coremind.__version__`, Worker startup, TypeScript/Python parity, and a Python callable round trip. Separately check Protocol v2 task/session access through a trusted registered host, restart, branches, and forks. Confirm bilingual documentation navigation and download links; partial channel success does not establish completion.

### Release metadata closeout

Perform this only after the public Release and exact public-artifact reinstall checks pass; a merged PR or green workflow alone never establishes publication.

1. Read-only verify that the target Tag, release manifest, and package versions agree, and that the release PR merge commit is an ancestor of the Tag commit.
2. On that release PR, remove `autorelease: pending` and add `autorelease: tagged`; this synchronizes an already verified publication state only.
3. Recheck the PR labels read-only and archive the evidence, preventing a later Release Please run from exiting successfully without a draft because of stale pending state.

Stop on any build, acceptance, OIDC, registry, attestation, or Release failure. Published npm/PyPI files are never overwritten; deprecate or withdraw the affected version and publish a higher corrected version. If registry publication succeeds but the Release step fails, resume from the saved artifact bundle rather than rebuilding. Restore the same provider entitlement before rerunning a failed certification; never substitute a provider or model silently.

## Current candidate sequencing

Prepare the version, documentation, engineering gates, and branch-safe offline checks in the draft release PR. Merge through the protected PR process, then freeze the resulting main commit. Strict Provider qualification requires that exact main commit and approved Runtime package digest, and must finish with both-platform PTY evidence before creating the tag or publishing. Historical exceptions do not apply to this candidate.
