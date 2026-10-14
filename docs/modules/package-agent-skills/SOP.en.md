# Skill and SOP Loading Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Choose legacy README text or SKILL.md with YAML `name` and `description` under the configuration directory's `skills/<id>/`. List the directory ID explicitly in the agent's `skills`. Standard names and descriptions must be non-empty strings; names are not call aliases.
2. Keep necessary procedures and business evidence in the body. Limit each source, including frontmatter, to 256 KiB. Resolver results and snapshots across all agents are separately limited to 2 MiB of serialized UTF-8 JSON. CoreMind does not automatically read references or execute adjacent scripts.
3. Verify built-in precedence, warned SKILL precedence over README, and failure without fallback for invalid standard files. Unselected IDs, arbitrary paths, escaping links, and permission errors must not bypass boundaries.
4. Exercise a real task: the first request contains only the index, then ToolPolicy-approved `load_skill` results enter the request. Compare actual body UTF-8 bytes and raw 64-character SHA values. Check repeated loads and reload after compaction against the final working set.
5. Verify frozen standard-skill identities in Runtime and Children. Resume after editing or removing source files must use the original start snapshot and existing configuration and recovery gates. Current files must not replace a missing or invalid snapshot.
6. Run the listed parser, helper, and Runtime regressions plus `npm run check:modules`. Complete request reconstruction also requires normal Session entries and compaction records; skill facts do not replace the conversation.
7. Check body storage in the raw Store and private-field stripping in public projections, events, and telemetry. Preserve traces, evaluations, and owner approval; do not publish without authorization. SHA checks are not signatures against arbitrary host rewrites.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
