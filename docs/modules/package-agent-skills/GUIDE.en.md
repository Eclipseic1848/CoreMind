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

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/package-agent-skills/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Check that the first request excludes unloaded bodies and that loaded bytes match their SHA in the actual request. Cover repeats, reload after compaction, recovery after source edits, and invalid arguments.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- An index, reference, or user claim is not proof of body residency. Skills cannot expand permissions or request arbitrary file paths.
- The raw Store contains frozen bodies. Stripping private fields from public projections is not universal output redaction or a signature against arbitrary rewrites.
- Disabling Session does not promise full conversation recovery. Complete request reconstruction still needs persisted session and compaction facts. See the [skills guide](../../en/guide/03-skills.md).
