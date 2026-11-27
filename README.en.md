# CoreMind

[简体中文](README.md) · [English documentation](https://eclipseic1848.github.io/CoreMind/en/) · [Quick start](docs/en/guide/01-quickstart.md) · [Latest release](https://github.com/Eclipseic1848/CoreMind/releases/latest)

CoreMind is a framework for building agents in your own application. Start with one model and a `coremind.yaml` file. Add knowledge retrieval, Hindsight memory, Skills, tools or ontology when your task needs them. The CLI/TUI, TypeScript SDK and synchronous and asynchronous Python clients use the same Node.js runtime, permissions, budgets and recovery rules.

## Quick start

Install Node.js 22.19 or later on Windows or Linux. Create a project with just a `coremind.yaml` file using the published CLI:

```sh
npx --yes coremind-cli@2.2.0 create my-agent --runtime-only --provider deepseek --model deepseek-flash
cd my-agent
```

Set the `DEEPSEEK_API_KEY` environment variable in your shell, then run the command below. It sends one prompt to DeepSeek Flash. To try CoreMind offline, run one of the [five examples with a local mock provider](examples/golden/README.en.md).

```sh
npx --yes coremind-cli@2.2.0 run coremind.yaml --prompt "Reply only OK"
```

| Embed in your application | Installation and example |
| --- | --- |
| TypeScript | Run `npm install --save-exact coremind-ai@2.2.0` and call the runtime from the [minimal TypeScript example](examples/modules/configure-coremind/runtime-only.mts). |
| Python 3.10 or later | Run `python -m pip install coremind-ai==2.2.0` and run the [minimal Python example](examples/modules/configure-coremind/runtime_only.py) in sync or async mode. The wheel includes the worker and requires Node.js at runtime. |

## Choose the capabilities you need

| Task | Where to start |
| --- | --- |
| Answer questions with traceable sources | The [knowledge service](examples/modules/manage-knowledge/README.en.md) supports ingestion, retrieval, citation lookup and withdrawal. |
| Remember confirmed information | [Hindsight memory](examples/modules/manage-memory/README.en.md) supports retention, recall, correction and forgetting. |
| Follow team procedures and use business systems | Pin and load [Skills](docs/en/guide/03-skills.md) on demand. Connect business systems through [tools](docs/modules/build-tools/GUIDE.en.md) with explicit permissions and budgets. |
| Act on business objects, relationships and constraints | The [ontology service](examples/modules/manage-ontology/README.en.md) supports object mapping, validation, action receipts and reconciliation. |
| Coordinate multiple steps and inspect results | Use [workflows](docs/modules/design-workflows/GUIDE.en.md) for sequential, parallel, conditional or verify-and-repair steps. [Durable tasks](docs/guides/durable-tasks.en.md) persist progress, and [traces](docs/modules/inspect-agent-traces/GUIDE.en.md) record execution. |

Knowledge, memory and ontology each have an independently installable and deployable MCP service. All three PyPI packages ship at 0.1.1 with CoreMind 2.2.0. [Capability guide](docs/en/guide/06-capability-construction.md) · [Deployment and recovery](examples/optional-components/README.en.md)

## Current stable release 2.2.0

This release fixes multiline workflow conditions and empty-string branches. It improves durable-task diagnostics, Python worker shutdown and approval handling, and responsiveness during long-running knowledge, memory and ontology operations. [Release notes and artifacts](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.2.0) · [2.1 to 2.2 upgrade and rollback](docs/migrations/2.1-to-2.2.en.md) · [Changelog](CHANGELOG.en.md)

- **Public installation.** The CLI and both SDKs are at 2.2.0. The release workflow downloaded and verified artifacts from GitHub, npm and PyPI. [npm CLI](https://www.npmjs.com/package/coremind-cli/v/2.2.0) · [PyPI SDK](https://pypi.org/project/coremind-ai/2.2.0/) · [Public reinstall results](https://github.com/Eclipseic1848/CoreMind/actions/runs/45952019764)
- **Model verification.** `deepseek-flash` passed 12 live API checks for this release. The matrix lists configurable providers and the qualification evidence for each version. [Qualification results](https://github.com/Eclipseic1848/CoreMind/actions/runs/45939479096) · [Provider matrix](docs/providers/README.en.md)
- **Task evaluation.** Review the fixed examples, how outputs are checked, and where live model runs still fail. [Evaluation guide](examples/modules/evaluate-agents/README.en.md) · [Generalization results in Chinese](examples/modules/evaluate-agents/GENERALIZATION.zh-CN.md) · [Known limitations](docs/release/KNOWN-LIMITATIONS.en.md)

## Documentation and community

[CLI guide](docs/en/guide/05-cli-usage.md) · [Configuration guide](docs/en/guide/02-configuration.md) · [Module catalog](docs/modules/README.en.md) · [SOP and Skill index](docs/modules/SOP-SKILL-INDEX.en.md) · [Roadmap](docs/roadmap.en.md)

[Contributing](CONTRIBUTING.en.md) · [Code of conduct](docs/en/community-code-of-conduct.md) · [Security policy and vulnerability reporting](SECURITY.en.md)

CoreMind is released under the [MIT License](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for dependencies and their licenses.
