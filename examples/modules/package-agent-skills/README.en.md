# Share a weekly report template and a release checklist

[The example configuration](coremind.yaml) selects two version `1.0.0` Skill packages for one agent and grants only the `load_skill` tool.

- The delivery and platform teams fill in the same weekly report template with their own progress, blockers, and plans.
- The Xingta staging environment and Yunqiao offline environment use one release checklist. Staging passes. The offline environment reports an outdated Node.js version and a missing rollback snapshot.
- A general notification summary completes without any skill calls.

To try a single local Skill, copy one example package to `skills/<id>/` under your own configuration directory and list only that ID on the intended agent. You can also write the `SKILL.md` yourself. The [standalone guide](../../../docs/modules/package-agent-skills/GUIDE.en.md) includes a complete configuration. The draft generator, acceptance scripts and model fixture run from source. Run `npm install --save-exact coremind-templates@2.2.0` to get the pinned `coremind-skill-install` command. The installed CLI can load a local Skill directly.

## Generate an editable draft from a task

Run `npm ci` and `npm run build` from the repository root first. The local command puts the task into a standard Skill template and validates it with the project loader. It runs without model credentials.

```sh
node examples/modules/package-agent-skills/draft-skill.mjs .scratch/skill-drafts compare-records "Compare two documents, list the changes and cite the version and source location for each."
node --test examples/modules/package-agent-skills/draft-skill.test.mjs
```

Open `.scratch/skill-drafts/compare-records/SKILL.md`. The draft uses the same task brief in two examples, one asking for the work and one asking only to quote the brief. Replace these with business-specific cases, state the scope in the description and edit the procedure and acceptance examples. Generating the same ID again in that directory refuses to overwrite it. After review, copy the whole `compare-records` folder into `skills/` next to the project configuration, add `compare-records` to the selected agent's `skills`, and run `coremind check <config-file>`. A new Runtime loads the Skill only when that agent explicitly selects its ID.

## Run the example across all four entry points

From the repository root, use Node.js with the repository dependencies installed and Python 3.10 or later. Set `COREMIND_SKILL_PYTHON` to the absolute interpreter path if needed.

```sh
npm run build
node examples/modules/package-agent-skills/acceptance.mjs
```

The script starts a local loopback model fixture and copies both packages into isolated temporary projects. CLI with YAML, the TypeScript SDK, and the synchronous and asynchronous Python SDKs each run the [same five cases](cases.json). Expect 20 JSON records with the entry point, case, skill calls, and output. The script verifies the returned resource bytes and checks that reading the script source creates no execution sentinel. This verifies the interface, isolation, and workflow. Use paired evaluation with the same prompts to measure a real model's skill selection.

To repeat the checks on a pinned installation, install both Skills in one configuration directory and pass that directory as the first argument to `acceptance.mjs`. [Installation steps](../../../docs/modules/package-agent-skills/GUIDE.en.md#pinned-installation-and-rollback)

## Run an offline Skill comparison

After building the repository, run the following commands. The [held-out cases](paired-holdout.json) include two tasks with overlapping language that require different Skills and two tasks that mention the same terms but only ask for editing or extraction. The enabled arm also includes a [weekly report audit Skill](skills/weekly-report-audit-fixture/SKILL.md) to check false triggers among similar Skills. The actual Runtime runs the same four cases in the enabled and disabled arms.

```sh
node examples/modules/package-agent-skills/paired-evaluation.mjs --offline .scratch/skill-paired.json
node examples/modules/package-agent-skills/paired-evaluation.mjs --rescore .scratch/skill-paired.json
```

The report includes fingerprints, per-field scores, actual Skill calls and load receipts, duration, and token totals for both arms. `scorerChecks` records the separate injected wrong-Skill and unrelated-task triggers. The arm totals cover the actual runs. The loopback fixture supplies simulated token usage and leaves monetary cost unavailable. Evaluation of real model selection requires a live paired run.

## Run a paired evaluation with a real model

Use an authorized, keyless Qwen-compatible endpoint. Set `COREMIND_SKILL_EVAL_BASE_URL` to its API base URL and `COREMIND_SKILL_EVAL_MODEL` to its model ID.

```sh
node examples/modules/package-agent-skills/paired-evaluation.mjs --plan
node examples/modules/package-agent-skills/paired-evaluation.mjs --run
```

The runner uses the same prompts and model settings with Skills enabled and disabled. It records scores, original output, tool calls, timing, and reported token usage in `.scratch/p2/skill-sharing/live-eval/`. Pass case IDs after `--run` to select specific cases. Use `--rescore <report-path>` to grade a recorded result offline.

To adapt the example, place the packages under `skills/` in your configuration directory. Update their instructions and resources, then record the SHA-256 of each resource's original UTF-8 bytes in `coremind.skill.json`. Set the Provider and the selected `skills` in YAML, then run `coremind check <config-file>`. See the [SOP](../../../docs/modules/package-agent-skills/SOP.en.md) for pinned installation and rollback, and the [guide](../../../docs/modules/package-agent-skills/GUIDE.en.md) for configuration.
