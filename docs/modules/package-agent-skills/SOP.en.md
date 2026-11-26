# Skill and SOP Loading Development SOP

Use `coremind-skill-install` from the current `coremind-templates` artifact. Verify the lock and resource bytes in an independent project, then select the Skill for the target agent. [Install and roll back](GUIDE.en.md#pinned-installation-and-rollback)

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

When starting from a task description, run the [draft generator](../../../examples/modules/package-agent-skills/README.en.md) outside the project's `skills/` folder. Have the owner edit `SKILL.md` and review the trigger and output format with a matching and a non-matching task. Copy the draft into the project and select its ID after review.

1. Write a standard `SKILL.md` under `skills/<id>/` and explicitly list the directory ID in the agent's `skills`. Put trigger conditions in the description and procedures in the body. Follow the [Agent Skills specification](https://agentskills.io/specification) for `references/`, `assets/`, and `scripts/`, and record the package version in `metadata.version`. Existing projects can still use legacy `README.md` skills.
2. Declare relative paths and SHA-256 values for raw UTF-8 bytes following the [package example](GUIDE.en.md#author-a-resource-package). Set Git line endings to LF. Each file is limited to 256 KiB. Resolver results and the multi-agent snapshot each have a 2 MiB serialized UTF-8 JSON limit.
3. Run `coremind check` to verify built-in precedence, the warning when both formats exist, and rejection of invalid packages, escaping paths, and links. Call `load_skill` to test rejection of undeclared paths. The agent can read script source as text. Script execution requires a separately registered tool and the project's approval and sandbox rules.
4. Follow [pinned installation and rollback](GUIDE.en.md#pinned-installation-and-rollback), and keep a lock file per version. Install and restore into two clean configuration directories, then compare lock and installed file hashes. Keep the previous lock before upgrading, verify that tampering leaves the previous version usable, and rehearse rollback.
5. Test a matching task, an unrelated task, and a missing prerequisite. Confirm the first model request contains only the index. Check that ToolPolicy-approved `load_skill({id})` and `load_skill({id, resource})` place the expected body and resource in the request. Cover repeat calls, reload after compaction, and rejection after permission revocation.
6. Change or remove source files after the first load. An existing run resumes with its original package, while a new Runtime gets the current version. Check that missing or corrupted snapshots fail and that raw Store fields stay private in public projections, events, and telemetry. Complete request reconstruction still requires persisted Session and compaction records.
7. Run the four entry points in the [module example](../../../examples/modules/package-agent-skills/README.en.md) and run `npm run check:modules`. Keep the [offline comparison](../../../examples/modules/package-agent-skills/README.en.md#run-an-offline-skill-comparison) for held-out cases, similar Skills, and tasks that should trigger neither Skill. Verify actual loads, task success, and the simulated token totals for both arms. For real-model comparison, use the same tasks, model, and parameters. Record procedure adherence, factual accuracy, unrelated triggers, latency, and actual tokens. Collect owner approval before publishing.

For independent acceptance, select just one Skill in the application’s minimal configuration. Record its version, commit or content lock, the selected agent, and an actual read. Update only that package and compare a new Runtime with a resumed run. Finally remove the ID and verify ordinary conversation in a fresh session.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.

## P2-C verification record

- On Windows, Skills CLI 1.9.0 installed both example Skills from a pinned GitHub commit and restored them in a second clean configuration directory using their original locks. The five release-check files matched byte for byte. The second directory passed the full four-entry matrix, 20/20. Regressions covered tampering, preservation of the prior version after a replacement failure, lock reuse on retry, and rollback. [Verified source commit](https://github.com/Eclipseic1848/CoreMind/commit/e4323b4b8e820e9495b42a1987a1f674f9caf448)
- The five deterministic cases passed across CLI/YAML, TypeScript, and synchronous and asynchronous Python, for 20/20 checks. All four unrelated summaries made zero Skill calls. Cold resume returned the original resource after approval and withheld it when denied. A new run used updated content. Declared script source was readable and no execution sentinel appeared.
- A paired comparison on the private `Qwen3.8-27B` service used temperature 0, thinking disabled, and a 512-token per-turn output limit. The first five cases scored 3/5 with Skills and 1/5 without. Both unrelated summaries were correct and triggered no tool calls. The enabled release checks reached the correct business decisions, but extra output failed the strict format. After clarifying the Skill output format, the same two cases and parameters scored 2/2 with the Skill and 0/2 without it, where both disabled runs hit the output limit. The enabled runs took 29.83 seconds and 4,151 tokens, and 25.09 seconds and 4,234 tokens respectively. These results cover the synthetic tasks and service configuration used here. [Reproduction instructions](../../../examples/modules/package-agent-skills/README.en.md)
