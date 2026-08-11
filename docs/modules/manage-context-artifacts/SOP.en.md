# Context and Artifact Governance Development SOP

## 1. Classify data

List stable instructions, dynamic messages, tool previews, complete output, credentials, and external business data. Stable instructions may enter the prefix, dynamic messages participate in compaction, complete output belongs in artifacts, and credentials belong in neither.

## 2. Stabilize the context prefix

1. Use fixed sections: core rules, project instructions, tool contract, stable facts, and professional skills.
2. Sort tool names and fact keys. Never include timestamps, random identifiers, or runtime credentials.
3. Execute twice with identical inputs and compare both text and SHA-256 fingerprint byte for byte.

## 3. Define compaction invariants

1. Check `contextWindow - reserveTokens` before every provider request.
2. Use the local deterministic summary by default without another model request.
3. Keep complete recent turns starting at a user message; never leave an orphan tool result.
4. Preserve goals, constraints, permissions, files, tests, unfinished work, next steps, and uncertain effects.
5. Return original messages and emit `context_compaction_failed` if compaction fails.

## 4. Govern large output

1. Import through `ArtifactStore` as a stream; never read a complete large file into memory.
2. Verify that the real controlled-root path remains inside the workspace.
3. Accept only temporary-output references created by trusted tools.
4. Scan for suspected credentials; delete staging data and return a blocked notice on a match.
5. Give the model only bounded head and tail sections, byte count, hash, media type, and workspace-relative path.
6. Apply project retention through `cleanup()` after preserving evidence that must remain auditable.

## 5. Record truthful metrics

Record input, output, cache read, cache write, compaction count, summary fingerprints, stable-prefix fingerprints, and artifact counts and bytes separately. Mark cache support unavailable when the locked model catalog does not declare cache pricing. Never infer a hit from possible provider support.

## 6. Compare strategies

Run `compareContextStrategies()` on the same message set. Compare no compaction, the current deterministic strategy, and the more-recent candidate. Change defaults only after considering recovery correctness, task success, tokens, and latency together.

## 7. Verification and stop conditions

Run all tests in the module manifest, then `npm run check:modules`, `npm run docs:audit`, and repository gates. Stop delivery for workspace escape, secrets in previews, missing critical output tails, summaries that omit incomplete work, or fabricated cache metrics.
