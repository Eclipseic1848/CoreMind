# Skill and SOP Loading Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Write a standard `SKILL.md` under `skills/<id>/` and explicitly list the directory ID in the agent's `skills`. Put trigger conditions in the description and procedures in the body. Follow the [Agent Skills specification](https://agentskills.io/specification) for `references/`, `assets/`, and `scripts/`, and record the package version in `metadata.version`. Existing projects can still use legacy `README.md` skills.
2. Declare relative paths and SHA-256 values for raw UTF-8 bytes following the [package example](GUIDE.en.md#author-a-resource-package). Set Git line endings to LF. Each file is limited to 256 KiB. Resolver results and the multi-agent snapshot each have a 2 MiB serialized UTF-8 JSON limit.
3. Run `coremind check` to verify built-in precedence, the warning when both formats exist, and rejection of invalid packages, escaping paths, and links. Call `load_skill` to test rejection of undeclared paths. The agent can read script source as text. Script execution requires a separately registered tool and the project's approval and sandbox rules.
4. Follow [pinned installation and rollback](GUIDE.en.md#pinned-installation-and-rollback), and keep a lock file per version. Install and restore into two clean configuration directories, then compare lock and installed file hashes. Keep the previous lock before upgrading, verify that tampering leaves the previous version usable, and rehearse rollback.
5. Test a matching task, an unrelated task, and a missing prerequisite. Confirm the first model request contains only the index. Check that ToolPolicy-approved `load_skill({id})` and `load_skill({id, resource})` place the expected body and resource in the request. Cover repeat calls, reload after compaction, and rejection after permission revocation.
6. Change or remove source files after the first load. An existing run resumes with its original package, while a new Runtime gets the current version. Check that missing or corrupted snapshots fail and that raw Store fields stay private in public projections, events, and telemetry. Complete request reconstruction still requires persisted Session and compaction records.
7. Run the four entry points in the [module example](../../../examples/modules/package-agent-skills/README.en.md) and run `npm run check:modules`. For real-model comparison, run with and without the skill using the same tasks, model, and parameters. Record procedure adherence, factual accuracy, unrelated triggers, latency, and tokens. Collect owner approval before publishing.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
