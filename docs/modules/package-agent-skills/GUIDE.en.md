# Skill and SOP Loading Guide

## When to use it

Assign a focused SOP to an agent. Built-ins and legacy README skills keep full prefix injection. To load a body on demand, use `skills/<id>/SKILL.md` under the configuration directory.

## Minimal example

```yaml
agents:
  reviewer:
    systemPrompt: Review the supplied contract using the project rules.
    skills:
      - legal-review
```

Create `skills/legal-review/SKILL.md`:

```markdown
---
name: Contract review
description: Compare clauses with project rules and report missing evidence.
---

Check payment, delivery, and liability. Ask for confirmation when business evidence is missing.
```

The directory ID controls authorization; the name is display metadata. The first request contains the index. The agent calls `load_skill({"id":"legal-review"})` before the body enters normal tool messages, subject to ToolPolicy and budgets. README remains supported. SKILL wins with a warning when both files exist; built-ins still take precedence on the same ID.

Each file is limited to 256 KiB. Resolver results and the complete multi-agent snapshot are separately limited to 2 MiB of serialized UTF-8 JSON. Body and snapshot SHA values are raw 64-character hexadecimal strings. Runtime creation freezes standard skills; Child execution and resume retain them instead of switching to current files. Create a new Runtime to read edits. Repeated loads return references only while the actual body remains in the final working set; compaction can make reloading necessary.

## Author a resource package

Add a `metadata` mapping to the `SKILL.md` frontmatter with `version: "1.0.0"`. For distribution, use the same lowercase, hyphenated identifier in the directory name and in `name`. Place resources in `references/`, `assets/`, or `scripts/`. For example, write `# Template` followed by one LF to `assets/template.md` in UTF-8 and create `coremind.skill.json` next to `SKILL.md`.

```json
{
  "schemaVersion": 1,
  "resources": [
    {
      "path": "assets/template.md",
      "sha256": "338468e66effd66f17adce09f28260126f5f502f3623e7aea481622c0e20f6a3"
    }
  ]
}
```

Calculate SHA-256 over the raw bytes. On Windows, run `Get-FileHash assets/template.md -Algorithm SHA256` and lowercase the result. On Linux, run `sha256sum assets/template.md`. Set `text eol=lf` in `.gitattributes` to keep the distributed bytes consistent with the digest. After reading the body, the agent can request the template with `load_skill({"id":"legal-review","resource":"assets/template.md"})`. Declared scripts are also returned as text. Execution requires separate project tool authorization.

## Pinned installation and rollback

Use Git, Node.js 22.20.0 or later, and a readable public GitHub source. From the CoreMind source root, prepare two existing configuration directories named `project-a` and `project-b`. Replace `owner/repo@FULL_COMMIT_SHA` with the reviewed repository and its 40-character lowercase commit SHA.

```sh
npm run build
npm install --prefix .scratch/skills-cli --cache .scratch/skills-cli/npm-cache --no-save --package-lock=false --ignore-scripts skills@1.9.0
node examples/modules/package-agent-skills/install-skill.mjs project-a legal-review .scratch/skills-cli/node_modules/skills/package.json .scratch/legal-review-v1.lock.json owner/repo@FULL_COMMIT_SHA
node examples/modules/package-agent-skills/install-skill.mjs project-b legal-review .scratch/skills-cli/node_modules/skills/package.json .scratch/legal-review-v1.lock.json
```

The installer runs a frozen Skills CLI install in a temporary directory, then checks raw bytes against the CoreMind manifest and pinned commit. It saves the verified lock before replacing the target directory. If replacement fails after the lock was saved, omit the source argument and retry with that lock. The project's `skills/<id>/` receives only `SKILL.md`, the manifest, and the declared resources. Run `coremind check project-a/coremind.yaml` to validate the package selected by the agent. Both installation commands should return the same lock SHA-256.

For upgrades, use a new commit and a new lock filename and retain the previous lock. To roll back, omit the source argument, change `project-b` to `project-a`, and pass the previous lock. A new Runtime reads the restored version. If installation is interrupted, confirm the installer has exited. When `skills/<id>/` is missing and `skills/.<id>.install/previous` exists, move `previous` back to `skills/<id>/`. Move the remaining `.<id>.install` directory outside `skills/` before retrying.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/package-agent-skills/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Check that the first request excludes unloaded bodies and resources and that loaded bytes match their SHA in the actual request. Cover repeats, reload after compaction, recovery after source edits, and invalid arguments.
6. Run `node --test examples/modules/package-agent-skills/install-skill.test.mjs` to check frozen restore, integrity, declared-file filtering, and rollback.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- An index, reference, or user claim is not proof of body residency. Skills cannot expand permissions or request arbitrary file paths.
- The raw Store contains frozen bodies. Stripping private fields from public projections is not universal output redaction or a signature against arbitrary rewrites.
- Disabling Session does not promise full conversation recovery. Complete request reconstruction still needs persisted session and compaction facts. See the [skills guide](../../en/guide/03-skills.md).
