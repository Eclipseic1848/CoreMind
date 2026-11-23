# Skills

A skill provides reusable procedures such as review checklists, writing templates, or translation rules. Built-in skills and legacy `README.md` skills enter the stable prompt prefix in full. Standard `SKILL.md` files supply metadata indexes, on-demand bodies, and declared resources. Validate their effect with scenario evaluations.

## Select a skill

```yaml
agents:
  reviewer:
    systemPrompt: Review the supplied contract using the project's rules.
    skills:
      - legal-review
```

Built-in IDs remain `code-review`, `weekly-report`, and `translation`. Project skills live under `skills/<id>/` in the configuration directory, or the SDK's `configDir`. The directory name is the ID. CoreMind resolves only explicitly selected IDs; it does not discover ancestor directories or remote skills.

Built-ins take precedence over project skills with the same ID. A directory containing only `README.md` retains full prefix injection and the existing built-ins-first, project-skills-second order. If both files exist, `SKILL.md` wins with a warning. An invalid standard file fails rather than falling back to README. Truly missing IDs still warn and are ignored.

## Standard skill format

Place this file at `skills/legal-review/SKILL.md`:

```markdown
---
name: Contract review
description: |
  Check payment, delivery, and liability terms.
  Report risks and unresolved questions.
---

Read the supplied contract and project rules before checking each clause. Mark missing evidence explicitly.
```

YAML `name` and `description` must be non-empty strings; Unicode names and multiline descriptions are supported. Names are display metadata, not aliases. Duplicate display names warn; selecting the same standard ID repeatedly produces one index entry.

## On-demand loading

The first model request contains only the authorized standard skills' IDs, names, descriptions, and body SHA-256 values. The current agent can call `load_skill({"id":"legal-review"})` to receive the frozen body. The tool accepts no path or agent override and cannot load an unselected ID. Calls still pass through ToolPolicy, approvals, and budgets. Skill instructions grant no additional file, network, or process permissions. A conflicting custom tool name is rejected when standard skills are enabled.

After a successful load, a repeated call returns a short reference while the body remains in the final model working set. If compaction removes the body, another call reloads the same frozen bytes. A reference, user claim, or historical load marker does not prove that the body is present in the current request. Normal tool-result messages feed budgets, actual requests, and reconstruction; the body is not also appended to the stable prefix.

## Reuse resources and pin versions

Set `metadata.version` in `SKILL.md`. In `coremind.skill.json` alongside it, declare files under `references/`, `assets/`, or `scripts/` with a SHA-256 digest of each file's raw UTF-8 bytes. Loading the body returns the package version and declared paths. The agent can request a declared template with `load_skill({"id":"legal-review","resource":"assets/template.md"})`. Current tool authorization applies to resource reads, and scripts are returned as text.

To share across projects, pin the full public GitHub commit and keep its lock file. Projects can restore identical packages from the same lock and roll back with a previous lock. [Authoring, installation, and rollback guide](../../modules/package-agent-skills/GUIDE.en.md#author-a-resource-package)

## Limits, freezing, and recovery

- Each project source file is limited to 256 KiB including frontmatter. Each resolver result and the complete snapshot across all agents are separately limited to 2 MiB of serialized UTF-8 JSON. Exceeding a limit fails explicitly.
- Directory and file boundaries are checked against canonical paths. Resource packages reject traversal, symlinks, junctions, and path aliases. Invalid UTF-8, permission failures, or source identity changes during reading fail explicitly.
- Body bytes and line endings after frontmatter are preserved. Body and snapshot SHA values are raw 64-character hexadecimal strings without a `sha256:` prefix.
- Runtime creation freezes selected bodies and declared resources for its Runs and Children. A new Runtime reads the current installation. Resume uses the original start snapshot and rejects invalid snapshots and selection mismatches. Existing body-only snapshots and configuration and resume gates remain supported.

The raw RunStore is trusted host data containing frozen bodies, resources, and load facts. Public projections, Worker events, and telemetry exports strip those private fields. Loaded text can still appear in normal sessions, model requests, or business output. SHA values check consistency.

Disabling Session does not provide full conversation recovery. Frozen snapshots and load facts support skill-result reconstruction; full request reconstruction still requires persisted session entries, compaction records, and the corresponding prefix. Store durability follows its existing contract.

Review the package before selecting its ID. Script execution uses a separately registered project tool under existing approval and sandbox rules. [Two resource reuse examples](../../../examples/modules/package-agent-skills/README.en.md)
