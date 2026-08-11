# Context and Artifact Governance

Status: \`0.3.0-rc.1\` release candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## What this module solves

Long tasks face two opposing risks: an ever-growing context can exceed the model window, while blunt truncation can lose unfinished work, approval decisions, or failure evidence. Sending complete tool output to the model wastes tokens and can expose credentials. This module separates model-visible context from complete local evidence.

## Stable contract

| Capability | Model-visible data | Complete evidence |
|---|---|---|
| Stable prefix | Core rules, project instructions, tools, facts, and skills in fixed order | SHA-256 fingerprint in traces and metrics |
| Context compaction | Local deterministic summary plus complete recent turns | Reason, token counts, and summary fingerprint |
| Large output | Bounded head and tail, byte summary, and relative artifact reference | `.coremind/artifacts/*.log`, size, hash, and media type |
| Prompt cache | Declared availability and actual read/write tokens | Aggregated provider usage; zero remains zero |

The summary preserves goals, constraints, approvals, changed files, test state, incomplete work, next steps, and uncertain effects. Thresholds are checked before every provider request, including requests inside a long loop.

## Security boundary

- The resolved artifact root must remain inside the workspace and names are framework-generated.
- Only trusted tool temporary-output paths can be imported; forged paths are neither read nor deleted.
- Suspected API keys, tokens, passwords, or private keys remove the model preview and delete both temporary and staged artifacts.
- Artifacts are local evidence. They are never uploaded or converted into cross-project memory automatically.
- Full permission mode does not disable path or credential protection.

## Public interfaces

- `buildStableContextPrefix()` creates a byte-stable prefix and fingerprint.
- `protectContext()` applies deterministic threshold compaction.
- `compareContextStrategies()` compares offline metrics without changing defaults.
- `ArtifactStore` streams imports, builds previews and hashes, and performs bounded cleanup.
- `RunMetrics.context` and `RunMetrics.artifacts` expose verifiable measurements.

## Source and evidence

- [Context implementation](../../../packages/coremind-runtime/src/context.ts)
- [Artifact implementation](../../../packages/coremind-tools/src/artifact-store.ts)
- [50 MB and secret-blocking tests](../../../packages/coremind-tools/src/artifact-store.test.ts)
- [Example](../../../examples/modules/manage-context-artifacts/README.en.md)
- [Development SOP](SOP.en.md)
- [Reusable skill](../../../skills/manage-context-artifacts/SKILL.md)
