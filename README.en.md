<div align="center">

# CoreMind

**Turn agent engineering practice into standards newcomers can execute and teams can reuse.**

[![Status](https://img.shields.io/badge/status-stable%20candidate-2563eb)](docs/roadmap.en.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-2563eb)](SECURITY.en.md)
[![Docs](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-7c3aed)](docs/en/index.md)
[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

CLI/TUI · TypeScript SDK · Python SDK · Configuration driven · Harness/Loop · SOP/Skills

[Quick Start](docs/en/guide/01-quickstart.md) · [Documentation](docs/en/index.md) · [Modules](docs/modules/README.en.md) · [Provider Matrix](docs/providers/README.en.md) · [Contribute](CONTRIBUTING.en.md) · [简体中文](README.md)

</div>

CoreMind is a configuration-driven agent development framework for newcomers and application engineers. It provides one Node runtime, a bounded Harness/Loop, CLI/TUI, TypeScript and Python SDKs, plus synchronized SOPs, Skills, bilingual guides, and offline examples.

> The current source is the unpublished `0.3.0` stable candidate. It retains the rc.2 harness, context/artifact engineering, Coding Kernel, bounded extensions, experiments, and shared snapshots. Use [GitHub Releases](https://github.com/Eclipseic1848/CoreMind/releases), [npm](https://www.npmjs.com/package/coremind-cli), and [PyPI](https://pypi.org/project/coremind-ai/) as the source of truth for installable availability.

> `0.3.0` is published only after the same candidate commit passes the Windows/Linux automated matrix, real pseudoterminal acceptance (Windows ConPTY / Linux PTY), a current live-provider recheck, the final documentation audit, and explicit maintainer publication authorization. Do not present the source version as publicly released while those stages remain open.

[Golden examples](examples/golden/README.en.md) · [SOP/Skill index](docs/modules/SOP-SKILL-INDEX.en.md) · [Migration guide](docs/migrations/0.2-to-0.3.en.md) · [Known limitations](docs/release/KNOWN-LIMITATIONS.en.md) · [Security](SECURITY.en.md) · [Code of Conduct](docs/en/community-code-of-conduct.md)

## What the current repository supports

The current `0.3.0` stable candidate keeps CLI/TUI, TypeScript, Python, and source on one runtime, protocol, and result model. The table describes the current repository; registries and Releases remain authoritative for installable capabilities.

| Capability | Current support |
|---|---|
| Development paths | CLI/TUI, TypeScript SDK, Python SDK, and full source |
| Agent orchestration | Single-agent and multi-agent runs, sequential/parallel/conditional workflows, public verify-repair Loops, no-progress detection, pause-resume, and exhaustion policies |
| Configuration and models | Config v2, 40 configurable providers, custom OpenAI-compatible endpoints, rc.2 seven-check evidence for one provider, and pending stable-candidate revalidation; see the [provider matrix](docs/providers/README.en.md) |
| Tools and permissions | Built-in file, search, web, and script tools; TypeScript/Python custom tools; controlled processes, read-only Git, and bounded unified diffs; `ask`, `assisted`, and `full` permission modes |
| Reliable execution | Explicit success/failure/pause/abort outcomes; turn, step, token, cost, and tool budgets; trace, run state, sessions, context protection, and safe resume |
| Change protection | Workspace path policy, approvals, pre-write checkpoints, diffs, explicit restore, and audit; built-in Linux shell commands also run in a network-disabled sandbox |
| Quality engineering | `check`, `eval`, three quality profiles, seven grader types, dirty-worktree preservation, failure injection, three-run stability, coverage floors, clean npm/wheel installation, and release preflight |
| Coding agents | Reproduce first, diagnose, make a minimal repair, run target and regression tests, and review the diff; the current offline Coding Eval passes 6/6, while the phase-two live external same-task comparison has not run |
| Learning system | Eight templates, five offline golden examples, two real-defect repositories, and 21 capability modules, each paired with tests, SOPs, a Skill, bilingual guides, and examples |
| Project scaffolding | New or existing TypeScript, JavaScript, and Python projects with code/test skeletons, evaluation scenarios, and project guidance |
| Current platforms | Windows and Linux; every publishable candidate must complete the automated matrix, real pseudoterminal acceptance on both platforms, and a live-provider recheck on the same source commit; Releases and registries remain authoritative for installation |

The current version does not include a complete Web development environment, an official hosted API, an official Docker image, a pure Python runtime, or formal macOS support. See the [public roadmap](docs/roadmap.en.md).

## Version roadmap

| Stage | Planned capabilities | Constraint that remains |
|---|---|---|
| Unpublished `0.3.0` stable candidate | Closes version and release-material preparation over the rc.2 lockstep dependencies, durable harness, context/artifact engineering, Coding/Engineering Kernel, and entry-point parity without new product behavior | CoreMind continues to own Config, Protocol, outcomes, permissions, effects, and recovery contracts |
| `0.3.x` stabilization | Continue reliability fixes, provider certification, and TUI/install improvements while running both-platform acceptance, target-platform CI, live-provider rechecks, and synchronized publication for every candidate | CLI, both SDKs, and source share one runtime; unverified or unrechecked capabilities are not presented as current evidence |
| Phase-three Web environment | Visual agent/tool/workflow configuration, online code editing, trace debugging, testing and evaluation, approvals, project files, and release guidance | The Web environment reuses CoreMind Protocol and does not create another execution engine |
| Later platform and ecosystem work | Formal macOS support and continued growth of community templates, Skills, provider evidence, and business modules | Every capability ships with implementation, tests, SOP, Skill, bilingual guidance, and examples |

`0.3.x` will continue to evolve from real defects, community feedback, and release evidence. CoreMind will still not decide business goals, approval ownership, or agent architecture for the user, and it does not plan to ship an official Docker image or become a hosted SaaS.

`0.3.0-rc.2` completed Batches 0 through 6 and public-artifact dogfooding. The current `0.3.0` stable candidate adds no product behavior; it synchronizes versions, release metadata, and required documentation. P01-P20, all eight npm tarballs, the Python wheel, the standalone source ZIP, 21 modules, and all audited Markdown files still enter the unified release gate. Stable-candidate provider status remains pending until the current-version revalidation is recorded.

## Product boundary

Users own business goals, rules, data fields, approval responsibility, architecture choices, and final acceptance. CoreMind owns mechanism safety, quality evidence, and development guidance. It does not attempt to generate every business application automatically.

The three supported use paths are:

- CLI/TUI for create, run, chat, approval, checks, and evaluation.
- TypeScript and Python SDKs embedded in an existing application.
- Full source for extension and community contribution.

Windows and Linux remain the formal target platforms. macOS support follows later. A complete web development environment belongs to phase three; the current scope does not ship an official hosted API platform or Docker image.

## Quick start

Node.js 22.19 or newer is required. Run the stable installation command below only after registries list `0.3.0`; during candidate validation, use source or the version currently shown by Releases and registries.

```bash
npm install -g coremind-cli@0.3.0
coremind providers
coremind create my-agent --template translator --language typescript --provider alibaba-model-studio
cd my-agent
cp .env.example .env
coremind check coremind.yaml
coremind run coremind.yaml --prompt "Translate: hello world"
coremind eval coremind.yaml
```

Interactive terminals ask for a provider; scripts and CI must pass `--provider` explicitly. Use `coremind providers` to inspect configurable entries and their certification status. The scaffold generates code and test skeletons, evaluation scenarios, bilingual requirements and architecture, development SOPs, testing guidance, an acceptance checklist, a project skill, a decision log, and checkpoint storage. Existing files are never overwritten.

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

`run`, `chat`, and `eval` accept `--permission ask|assisted|full`. Full mode skips per-operation prompts, but explicit deny rules, audit, trace, checkpoints, workspace policy, and network policy remain active. On Linux, built-in bash runs in an OS sandbox with network disabled and workspace-only writes, and fails closed when the sandbox is unavailable. On Windows, host-shell execution requires full mode, `workspaceOnly: false`, and `network: allow`; every other combination is denied. Git Bash discovery provides command compatibility rather than isolation.

`coremind run` exposes stable automation exit codes: `0` succeeded, `1` failed, `2` paused for human action, `3` budget exhausted, `124` timed out, and `130` aborted. With `--json-events`, stdout is JSONL and its final line is always a `type: "run_result"` terminal record; diagnostics go to stderr. `--print` and `--json-events` are mutually exclusive so machine output cannot be contaminated by plain text.

The Linux sandbox dependency is still an upstream research preview and is used as a defense-in-depth mechanism. Security conclusions rely on the complete permission policy, recovery controls, and automated test evidence.

## SDK architecture

TypeScript applications import the public facade from `coremind-ai`. Python applications use `CoreMindClient` or `AsyncCoreMindClient`; a persistent stdio JSON-RPC worker executes the same Node runtime. Python is not a separate agent loop.

Every run separates:

- `RunOutcome`: success, failure, pause, abort, timeout, or budget exhaustion and the explicit reason.
- `RunMetrics`: duration, turns, steps, tool calls, retries, tokens, and cost when available.
- `EvaluationReport`: scenario results, scores, and security findings.
- `ReleaseReadiness`: blockers, warnings, and recorded non-security overrides.

An unfinished run can be continued with `coremind run <file> --resume <runId>` or the SDK resume API. Resume reuses only complete persisted workflow-step outputs. It rejects finished runs, mismatched configuration or input, and incomplete steps that invoked non-replay-safe tools. Tool-call idempotency identifiers are correlation inputs for business-side receipt or deduplication; they are not an exactly-once guarantee.

Custom tools must declare `effect.operations` and `effect.reversible`. The permission layer recursively inspects nested paths and URLs, and fails closed for undeclared effects under workspace or network restrictions. In ask mode, a human denial blocks that tool and later unapproved calls in the same batch. The run returns `paused` after batch reconciliation without another model request or approval prompt. In a sequential workflow, the denied step saves no output and no later step starts. File restore also checks the post-tool fingerprint and refuses to overwrite a file changed later by a user or concurrent process.

## Provider policy

CoreMind exposes a locked catalog of 40 configurable providers and also supports custom OpenAI-compatible endpoints. Configurable support is not certification. Current certification requires live streaming, tool-call, structured-result, multi-turn, abort, error-mapping, and long-context evidence on the same version. Older five-check evidence remains traceable but does not satisfy the current contract. `alibaba-model-studio/qwen-plus` completed all seven checks against `0.3.0-rc.2`, so the matrix currently reports one certified and 39 unverified entries.

Telemetry is off by default. Business-data egress requires explicit user authorization, and secrets belong in `apiKeyEnv`, not YAML.

See the generated [provider matrix](docs/providers/README.en.md) and [certification SOP](docs/providers/CERTIFICATION.en.md).

## Learning and verification

- [21 capability modules](docs/modules/README.en.md), each with implementation paths, tests, bilingual README/SOP/guides, a reusable skill, examples, and `module.yaml`.
- [5 offline golden examples](examples/golden/README.en.md): order support, contract review, Python data analysis, bounded research, and verified repair.
- [2 real-defect coding-agent repositories](examples/coding-evals/README.en.md): TypeScript and Python cases verify reproduction, minimal repair, target/regression tests, read-only Git evidence, and dirty-worktree preservation.
- `npm run check:modules` verifies bilingual pairs, skill frontmatter, paths, Markdown links, Config v2 examples, and version records.

## Source verification

```bash
npm ci
npm run build
npm run check
npm run test:stability
npm run test:coverage
npm run test:coding-evals
npm run build:python-worker
npm run release:check-npm
npm run release:test-npm
npm run release:test-source
python -X utf8 -m build --wheel python
npm run release:check-wheel
```

CI targets Windows and Linux, runs the Node suite three consecutive times, and checks non-decreasing coverage, the Python SDK, real Worker parity, golden examples, npm tarballs, and clean wheel installation. P20 uses an automated real pseudoterminal on the target platform; a manual review is added only when the script and visible terminal behavior disagree.

## License

[MIT](LICENSE) · [Contributing](CONTRIBUTING.en.md) · [Security](SECURITY.en.md) · [Code of Conduct](docs/en/community-code-of-conduct.md) · See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for dependency notices.
