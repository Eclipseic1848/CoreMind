# CoreMind Release SOP

This SOP publishes GitHub source, eight npm packages including the CLI and TypeScript SDK, the PyPI Python SDK, an independent source ZIP, a GitHub Release, and the bilingual documentation site from one commit and at one stability level.

[简体中文](README.zh-CN.md) · [RC acceptance](RC-ACCEPTANCE.en.md) · [Known limitations](KNOWN-LIMITATIONS.en.md) · [0.2→0.3 migration](../migrations/0.2-to-0.3.en.md)

## Principles

- Version, commit, tag, artifact manifest, and public documentation must agree.
- TypeScript and Python ship together. The Python SDK continues to call the same Node runtime.
- Release Please creates or updates a **draft release PR only**. It does not tag or publish.
- npm and PyPI use GitHub OIDC trusted publishing; the repository and workflow do not store long-lived registry tokens.
- External GitHub Actions are pinned to full commit SHAs. Dependabot opens weekly update pull requests for Actions, npm, and Python dependencies, and those updates must pass the complete gate before merge.
- Artifacts are built once. npm, PyPI, attestations, and the GitHub Release all download that same build.
- A failed live provider, Windows TTY, Linux TTY, platform CI, or repository-wide Markdown audit stops publication.

## One-time account configuration

Create protected GitHub environments named `npm` and `pypi`, both requiring maintainer approval. Configure Trusted Publishers for all eight npm packages with repository `Eclipseic1848/CoreMind`, workflow `publish-pypi.yml`, and environment `npm`. Configure the PyPI `coremind-ai` publisher with the same repository and workflow plus environment `pypi`. The workflow filename and environment are part of the OIDC identity; renaming either requires a coordinated registry-side update and revalidation.

## Freeze the candidate

Run the `Prepare Release Pull Request` workflow with a target such as `0.3.0-rc.2`. Release Please opens a draft PR. In that PR, synchronize every npm and Python version:

```powershell
npm run release:sync-version -- 0.3.0-rc.2
npm run release:preflight -- --allow-dirty
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

Property tests must use repository-fixed seeds, and host-capability discovery must be exercised through injectable deterministic cases. If the same commit produces coverage drift across repeats or runners, remove the test nondeterminism before changing any floor.

Follow the [RC acceptance guide](RC-ACCEPTANCE.en.md). P01-P19 and their evidence anchors must pass; real Windows ConPTY and Linux PTY evidence must bind to the same version and commit; and a currently authorized provider must pass streaming, tool, structured-result, multi-turn, and error-path rechecks. Actual P20 JSON stays in ignored `.scratch/rc-evidence/` and is archived with the workflow run identifier; the source commit retains templates only, avoiding a commit-SHA self-reference. Finish with:

```powershell
npm run acceptance:rc -- --require-manual
```

## Merge, tag, and publish

After the final Markdown audit, mark the release PR ready. Merge only after both platform checks pass. Create `v<version>` on the merge commit; the tag must equal the root manifest version. Tag creation does not publish.

Manually run `Publish CoreMind Release` with the existing tag. The workflow checks out that tag, builds eight npm tarballs, one wheel, and one independent source ZIP, validates exact contents and clean installs, and rejects ZIP path traversal through a cross-platform decoder before writing `release-manifest.json` and `SHA256SUMS.txt`. Every consumer independently verifies the checksum file before an isolated job creates the GitHub build attestation or protected OIDC jobs publish the exact npm artifacts and wheel. Pre-releases use npm `next`; stable versions use `latest`. The GitHub Release is created only after npm, PyPI, and attestation succeed, then the release job explicitly dispatches bilingual documentation deployment from `main` through `workflow_dispatch`. The Release event route remains a fallback for releases created manually by a maintainer.

The Release attaches only the independent source ZIP, checksums, and manifest in addition to GitHub's unavoidable automatic source zip/tar.gz links. Publication supports safe continuation: existing same-name, same-version npm, PyPI, or GitHub Release assets are skipped only when their hashes match; missing assets are uploaded and hash conflicts fail immediately. Published versions remain immutable, so conflicts require a higher repaired version.

## Public-registry verification and failure handling

Verify the CLI from a fresh global install, create a new project, and run `coremind check`. In a new Python virtual environment, install the exact PyPI version and verify `coremind.__version__`, Worker startup, TypeScript/Python parity, and a Python callable round trip. Confirm GitHub hashes plus bilingual documentation navigation and download links.

Stop on any build, acceptance, OIDC, registry, attestation, or Release failure. Published npm/PyPI files are never overwritten; deprecate or withdraw the affected version and publish a higher corrected version. If registry publication succeeds but the Release step fails, resume from the saved artifact bundle rather than rebuilding. Restore the same provider entitlement before rerunning a failed certification; never substitute a provider or model silently.
