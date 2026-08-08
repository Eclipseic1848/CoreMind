<div align="center">

# CoreMind

**Turn agent engineering practice into standards newcomers can execute and teams can reuse.**

[![Status](https://img.shields.io/badge/status-beta%20candidate-2563eb)](docs/roadmap.en.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-2563eb)](SECURITY.en.md)
[![Docs](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-7c3aed)](docs/en/index.md)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

CLI/TUI · TypeScript SDK · Python SDK · Configuration driven · Harness/Loop · SOP/Skills

[Quick Start](docs/en/guide/01-quickstart.md) · [Documentation](docs/en/index.md) · [Modules](docs/modules/README.en.md) · [Provider Matrix](docs/providers/README.en.md) · [Contribute](CONTRIBUTING.en.md) · [简体中文](README.md)

</div>

CoreMind is a configuration-driven agent development framework for newcomers and application engineers. It provides one Node runtime, a bounded Harness/Loop, CLI/TUI, TypeScript and Python SDKs, plus synchronized SOPs, Skills, bilingual guides, and offline examples.

> The current public version is `0.2.0-beta.2`. This release fixes TUI abort handling, denied-tool outcome semantics, and Session configuration guidance. GitHub, npm, PyPI, the bilingual documentation site, Windows/Linux CI, and one live provider certification are covered. You are welcome to try it and contribute to the community.

[Golden examples](examples/golden/README.en.md) · [Security](SECURITY.en.md) · [Code of Conduct](docs/en/community-code-of-conduct.md)

## What the current version supports

`0.2.0-beta.2` is the unified phase-one release candidate. All three entry paths share one runtime and one result model.

| Capability | Current support |
|---|---|
| Development paths | CLI/TUI, TypeScript SDK, Python SDK, and full source |
| Agent orchestration | Single-agent and multi-agent runs, sequential/parallel/conditional workflows, bounded loops, retries, and timeouts |
| Configuration and models | Config v2, 38 configurable providers, custom OpenAI-compatible endpoints, and one provider with complete live certification evidence |
| Tools and permissions | Built-in file, search, web, and script tools; TypeScript/Python custom tools; `ask`, `assisted`, and `full` permission modes |
| Reliable execution | Explicit success/failure/pause/abort outcomes; turn, step, token, cost, and tool budgets; trace, run state, sessions, context protection, and safe resume |
| Change protection | Workspace path policy, approvals, pre-write checkpoints, diffs, explicit restore, and audit; built-in Linux shell commands also run in a network-disabled sandbox |
| Quality engineering | `check`, `eval`, development/standard/strict gates, scenario evaluation, failure injection, and release preflight |
| Learning system | Eight templates, four offline golden examples, and 16 capability modules, each paired with tests, SOPs, a Skill, bilingual guides, and examples |
| Project scaffolding | New or existing TypeScript, JavaScript, and Python projects with code/test skeletons, evaluation scenarios, and project guidance |
| Current platforms | Windows and Linux are the phase-one targets; local candidate automation is verified on Windows and public CI is the final Linux gate |

The current version does not include a complete Web development environment, an official hosted API, an official Docker image, a pure Python runtime, or formal macOS support. See the [public roadmap](docs/roadmap.en.md).

## Version roadmap

| Stage | Planned capabilities | Constraint that remains |
|---|---|---|
| `0.2.x` phase-one stabilization | Complete the Windows/Linux release candidate and public release; continue reliability fixes, live provider certifications, and TUI/install improvements | CLI, both SDKs, and source continue to share one runtime; unverified capabilities are not advertised as certified |
| Phase-two Web environment | Visual agent/tool/workflow configuration, online code editing, trace debugging, testing and evaluation, approvals, project files, and release guidance | The Web environment reuses CoreMind Protocol and does not create another execution engine |
| Later platform and ecosystem work | Formal macOS support and continued growth of community templates, Skills, provider evidence, and business modules | Every capability ships with implementation, tests, SOP, Skill, bilingual guidance, and examples |

Exact post-phase-one versions and dates will be set after real user feedback. CoreMind will still not decide business goals, approval ownership, or agent architecture for the user, and it does not plan to ship an official Docker image or become a hosted SaaS.

## Product boundary

Users own business goals, rules, data fields, approval responsibility, architecture choices, and final acceptance. CoreMind owns mechanism safety, quality evidence, and development guidance. It does not attempt to generate every business application automatically.

The three supported use paths are:

- CLI/TUI for create, run, chat, approval, checks, and evaluation.
- TypeScript and Python SDKs embedded in an existing application.
- Full source for extension and community contribution.

Phase one targets Windows and Linux. macOS support follows later. A complete web development environment belongs to phase two; phase one does not ship an official hosted API platform or Docker image.

## Quick start

Node.js 22.19 or newer is required.

```bash
npm install -g coremind-cli@beta
coremind create my-agent --template translator --language typescript
cd my-agent
cp .env.example .env
coremind check coremind.yaml
coremind run coremind.yaml --prompt "Translate: hello world"
coremind eval coremind.yaml
```

The scaffold generates code and test skeletons, evaluation scenarios, bilingual requirements and architecture, development SOPs, testing guidance, an acceptance checklist, a project skill, a decision log, and checkpoint storage. Existing files are never overwritten.

## CLI

```text
coremind create <name>       Create or adopt a project
coremind run <file>          Headless run with print, JSON events, sessions, and safe resume
coremind chat <file>         Multi-turn TUI/readline with approvals and checkpoints
coremind check [file]        Configuration, security, material, and quality gates
coremind eval [file]         Repeat scenarios from evals/scenarios.yaml
coremind doctor [file]       Environment and provider diagnostics
coremind templates           List templates
```

`run`, `chat`, and `eval` accept `--permission ask|assisted|full`. Full mode skips per-operation prompts, but explicit deny rules, audit, trace, and checkpoints remain active; path-aware file tools still enforce workspace policy. On Linux, built-in bash runs in an OS sandbox with network disabled and workspace-only writes, and fails closed when the sandbox is unavailable. Windows does not yet have an OS-level shell sandbox, so shell and custom-tool side effects remain high-risk and non-reversible.

The Linux sandbox dependency is still an upstream research preview and is used as a defense-in-depth mechanism. Security conclusions rely on the complete permission policy, recovery controls, and automated test evidence.

## SDK architecture

TypeScript applications import the public facade from `coremind-ai`. Python applications use `CoreMindClient` or `AsyncCoreMindClient`; a persistent stdio JSON-RPC worker executes the same Node runtime. Python is not a separate agent loop.

Every run separates:

- `RunOutcome`: success, failure, pause, or abort and the explicit reason.
- `RunMetrics`: duration, turns, steps, tool calls, retries, tokens, and cost when available.
- `EvaluationReport`: scenario results, scores, and security findings.
- `ReleaseReadiness`: blockers, warnings, and recorded non-security overrides.

An unfinished run can be continued with `coremind run <file> --resume <runId>` or the SDK resume API. Resume reuses only complete persisted workflow-step outputs. It rejects finished runs, mismatched configuration or input, and incomplete steps that invoked non-replay-safe tools. Tool-call idempotency identifiers are correlation inputs for business-side receipt or deduplication; they are not an exactly-once guarantee.

## Provider policy

CoreMind exposes a locked provider catalog plus a native certified endpoint, and also supports custom OpenAI-compatible endpoints. Configurable support is not certification. A provider becomes CoreMind Certified only after real streaming, tool-call, structured-result, multi-turn, and error-handling evidence exists.

Telemetry is off by default. Business-data egress requires explicit user authorization, and secrets belong in `apiKeyEnv`, not YAML.

See the generated [provider matrix](docs/providers/README.en.md) and [certification SOP](docs/providers/CERTIFICATION.en.md).

## Learning and verification

- [16 capability modules](docs/modules/README.en.md), each with implementation paths, tests, bilingual README/SOP/guides, a reusable skill, examples, and `module.yaml`.
- [4 offline golden examples](examples/golden/README.en.md): order support, contract review, Python data analysis, and bounded research.
- `npm run check:modules` verifies bilingual pairs, skill frontmatter, paths, Markdown links, Config v2 examples, and version records.

## Source verification

```bash
npm ci
npm run build
npm run check
npm test
npm run build:python-worker
```

CI targets Windows and Linux and exercises the Node packages, Python SDK, real worker parity, golden examples, and wheel construction.

## License

[MIT](LICENSE) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Code of Conduct](docs/en/community-code-of-conduct.md) · See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency notices.
