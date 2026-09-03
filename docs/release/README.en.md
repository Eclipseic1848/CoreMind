# CoreMind Release SOP

This SOP publishes GitHub source, eight npm packages including the CLI and TypeScript SDK, the PyPI Python SDK, an independent source ZIP, a GitHub Release, and the bilingual documentation site from one commit and at one stability level.

> The `v0.7.0` tag exists, while the GitHub Release, npm, PyPI, and public reinstall remain pending. The steps below remain the standard publication and recovery process for `0.7.0` and later releases.

[简体中文](README.zh-CN.md) · [RC acceptance](RC-ACCEPTANCE.en.md) · [Known limitations](KNOWN-LIMITATIONS.en.md) · [0.2→0.3 migration](../migrations/0.2-to-0.3.en.md)

## Principles

- Version, commit, tag, artifact manifest, and public documentation must agree.
- TypeScript and Python ship together. The Python SDK continues to call the same Node runtime.
- Release Please only creates or updates the release PR, and the workflow then immediately and idempotently converts a newly created ready PR to draft. It never tags or publishes. Conversion leaves a brief ready window, so repository auto-merge must remain disabled and no publication side effect may depend only on a PR being ready.
- npm and PyPI use GitHub OIDC trusted publishing; the repository and workflow do not store long-lived registry tokens.
- External GitHub Actions are pinned to full commit SHAs. Dependabot opens weekly update pull requests for Actions, npm, and Python dependencies, and those updates must pass the complete gate before merge.
- Artifacts are built once. npm, PyPI, attestations, and the GitHub Release all download that same build.
- A failed live provider, Windows TTY, Linux TTY, platform CI, or repository-wide Markdown audit stops publication, except for the single maintainer decision documented below for `0.7.0`.

## One-time account configuration

Create protected GitHub environments named `npm` and `pypi`, both requiring maintainer approval. Configure Trusted Publishers for all eight npm packages with repository `Eclipseic1848/CoreMind`, workflow `publish-pypi.yml`, and environment `npm`. Configure the PyPI `coremind-ai` publisher with the same repository and workflow plus environment `pypi`. Allow GitHub Actions to create pull requests, keep repository auto-merge disabled, and do not configure irreversible automation that runs only because a PR is ready. The workflow filename and environment are part of the OIDC identity; renaming either requires a coordinated registry-side update and revalidation.

## Freeze the candidate

Run the `Prepare Release Pull Request` workflow with a target such as `0.7.0`. The workflow uses Release Please's non-manifest entry so that this input directly controls version calculation, then immediately converts the created PR to draft. A failure to create or convert the PR stops candidate preparation. In that draft PR, synchronize every npm and Python version:

```powershell
npm run release:sync-version -- 0.7.0
npm run release:preflight -- --allow-dirty
```

Both-platform CI on an ordinary feature branch may explicitly use `--defer-provider-certification` on both `release:preflight` and the nested `acceptance:rc` command. This defers only the requirement that the in-development Runtime already have a live-provider certification. The mode must emit a warning and must not be used for a release candidate, tag, `release:bundle`, or the publication workflow; those paths still require live evidence bound to the exact version and Runtime SHA-256. An environment variable cannot enable deferred mode.

`0.7.0` has one maintainer-approved Provider network exception. Both candidate platforms passed in strict run `33582995518`, but the first `alibaba-model-studio/qwen-plus` request timed out before an HTTP response. The publication workflow accepts `--allow-provider-network-waiver` only for `v0.7.0` when the Runtime digest is unchanged, the Issue #113 decision is still valid, the original run and failed job still match, and a new both-platform offline candidate run exists for the release commit. The flag cannot be enabled through an environment variable, does not update the successful Provider ledger, and is invalid for every other version.

For this release, the strict preflight command is:

```powershell
npm run release:preflight -- --allow-dirty --allow-provider-network-waiver
```

The synchronizer updates the root manifest, all eight public npm packages, exact internal dependencies, the lockfile, Python PEP 440 metadata, and `coremind.__version__`. Update both changelogs, READMEs, migration guidance, provider state, third-party notices, and roadmaps before marking the PR ready.

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

P0-17 stores the maintainer's read-only `main` ruleset export and bypass actor in [`v0.7.0-main-ruleset.json`](evidence/v0.7.0-main-ruleset.json). The publication workflow separately queries the current ruleset target, mandatory rules, approval count, check names, and GitHub App integration IDs. The pull request containing that evidence must still merge through both required Engineering checks; the snapshot does not replace the controlled-PR proof.

Property tests must use repository-fixed seeds, and host-capability discovery must be exercised through injectable deterministic cases. If the same commit produces coverage drift across repeats or runners, remove the test nondeterminism before changing any floor.

Follow the [RC acceptance guide](RC-ACCEPTANCE.en.md). P01-P19 and their evidence anchors must pass; real Windows ConPTY and Linux PTY evidence must bind to the same version and commit; and a currently authorized provider must normally pass streaming, tool, structured-result, multi-turn, and error-path rechecks. The exact `0.7.0` exception above must be recorded as waived, never certified. Actual P20 JSON stays in ignored `.scratch/rc-evidence/` and is archived with the workflow run identifier; the source commit retains templates only, avoiding a commit-SHA self-reference. Finish with:

```powershell
npm run acceptance:rc -- --require-manual --allow-provider-network-waiver
```

## Merge, tag, and publish

After the final Markdown audit, mark the release PR ready. Merge only after both platform checks pass. Create `v<version>` on the merge commit; the tag must equal the root manifest version. Tag creation does not publish. After tagging, rerun strict preflight; `v0.7.0` uses `npm run release:preflight -- --allow-provider-network-waiver`.

Manually run `Publish CoreMind Release` with the existing tag. The workflow checks out that tag, builds eight npm tarballs, one wheel, and one independent source ZIP, validates exact contents and clean installs, and rejects ZIP path traversal through a cross-platform decoder before writing `release-manifest.json` and `SHA256SUMS.txt`. Every consumer independently verifies the checksum file before an isolated job creates the GitHub build attestation or protected OIDC jobs publish the exact npm artifacts and wheel. Candidate, release, and public-reinstall stages produce top-level P0-01–P0-20, P0-01–P0-21, and P0-01–P0-22 reports. Pre-releases use npm `next`; stable versions use `latest`. The GitHub Release is created only after npm, PyPI, and attestation succeed, then the release job explicitly dispatches bilingual documentation deployment from `main` through `workflow_dispatch`. The Release event route remains a fallback for releases created manually by a maintainer.

The Release attaches only the independent source ZIP, checksums, and manifest in addition to GitHub's unavoidable automatic source zip/tar.gz links. Leave `artifact_run_id` empty for the first run. That path first proves the same commit has no earlier successful Build and that the target version is explicitly absent from the GitHub Release, all eight npm packages, and PyPI; any existing or unknown state refuses a rebuild. After a partial publication or uncertain network result, pass the original publication run ID: the workflow accepts only a saved bundle from the same workflow and commit with a successful Build and matching tag, version, manifest, and checksums; it never rebuilds that continuation. Existing same-name, same-version npm, PyPI, or GitHub Release assets are skipped only when their hashes match; missing assets are uploaded and hash conflicts fail immediately. Published versions remain immutable, so conflicts require a higher repaired version.

## Public-registry verification and failure handling

The workflow downloads every target artifact again from npm and PyPI, compares each SHA-256 with the saved release bundle, and validates all eight npm entries, the CLI, bundled Worker, and a basic Child Run in clean environments. Maintainers should additionally verify the CLI from a fresh global install, create a new project, run `coremind check`, and use a new Python virtual environment to verify `coremind.__version__`, Worker startup, TypeScript/Python parity, and a Python callable round trip. Confirm bilingual documentation navigation and download links.

Stop on any build, acceptance, OIDC, registry, attestation, or Release failure. Published npm/PyPI files are never overwritten; deprecate or withdraw the affected version and publish a higher corrected version. If registry publication succeeds but the Release step fails, resume from the saved artifact bundle rather than rebuilding. Restore the same provider entitlement before rerunning a failed certification; never substitute a provider or model silently.
