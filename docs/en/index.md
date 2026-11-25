---
layout: home

hero:
  name: CoreMind
  text: Turn agent engineering practice into executable standards
  tagline: A configuration-driven framework for newcomers and application engineers, available as a CLI, TypeScript SDK, Python SDK, and source code.
  actions:
    - theme: brand
      text: Start in 5 minutes
      link: /en/guide/01-quickstart
    - theme: alt
      text: Configuration guide
      link: /en/guide/02-configuration
    - theme: alt
      text: View on GitHub
      link: https://github.com/Eclipseic1848/CoreMind

features:
  - title: Configuration driven
    details: Describe models, tools, permissions, budgets, and quality gates without assembling an execution engine from scratch.
  - title: Built-in harness
    details: Budgets, retries, checkpoints, traces, evaluations, and recovery live inside one bounded execution model.
  - title: Three entry points
    details: Work interactively in a terminal, embed the SDK, or extend the source while keeping consistent runtime semantics.
  - title: Human control
    details: Users choose ask, auto-approve, or full-access permission modes. High-risk actions retain explicit boundaries.
  - title: Bilingual learning path
    details: Every module includes a README, guide, SOP, Skill, test entry points, and changelog.
  - title: Evidence-based releases
    details: Provider certification, cross-language parity, installation tests, and release checks rely on reproducible evidence.
---

## Public stable release `2.0.0`

[Upgrade from 1.4](../migrations/1.4-to-2.0.en.md) · [2.0 release notes](../release/notes/v2.0.0.md) · [Historical 1.0.1→1.2 upgrade](../migrations/1.0-to-1.2.en.md)

> Start the Runtime in your own project, then select knowledge, Hindsight memory, Skills, tools or an optional ontology as needed. The 2.0.0 release provides Skill, tool and MCP interfaces and includes the knowledge, memory and ontology services in its source examples. 2.0.0 was released on 2026-11-25 (UTC). Install the matching CLI and Python SDK from the registries. [GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0) · [npm](https://www.npmjs.com/package/coremind-cli/v/2.0.0) · [PyPI](https://pypi.org/project/coremind-ai/2.0.0/)

### Try the `2.1.0` candidate

Use candidate clients from one build to create a Runtime-only project. Knowledge, Hindsight memory and ontology each have a separate `0.1.0` service wheel. Install a Skill at a reviewed commit, or register and replace a business tool on its own. For the public stable release, use the `2.0.0` links above. [Candidate installation and rollback](../migrations/2.0-to-2.1.en.md) · [2.1.0 changes](../release/notes/v2.1.0.md)

### Enable one capability in your own project

Start with a provider and one agent. Connect one component, test it, and check what happens when you remove it. The `document-assistant` example shows how several components work together. [Construction guide](guide/06-capability-construction.md)

### Capabilities merged for 1.4

- [Durable tasks](../guides/durable-tasks.en.md): atomic phases, definition migration, durable waits and keyed result reuse; hosts own alarms and explicit recovery.
- [Session trees and forks](../modules/manage-sessions/GUIDE.en.md): named branches, durable selection and new session identities without copied execution authorization.
- [Cross-language SDKs](../modules/embed-coremind-python/GUIDE.en.md): TS and sync/async Python share one Node Runtime, authoritative facts and permission boundaries with matching Protocol v2 capabilities and fingerprints.

### Capabilities retained from 1.2

- Standard `SKILL.md` indexing, on-demand loading, and frozen-snapshot recovery.
- Durable same-Run `/steer`, `/follow-up`, and five-state control receipts.
- Permission-gated local MCP stdio tools and cancellation settlement.
- Fixed HTTP MCP targets, exact resource authorization, and controlled credentials.
- Explicit host OAuth login, cancellation, exit, and logout.
- Explicit Config v3 `deferred` Chinese/English lexical discovery, declaration generation, and fact reconstruction.
- Terminal evidence per Run/Call, controlled Artifact references, and safe input.

Config v2, omitted or explicit `direct` tools, and Protocol v1 remain compatible; `deferred` requires explicit Config v3. New features require matching SDK and bundled Worker capabilities; Protocol v2 also requires matching Schema fingerprints. Node.js ≥ 22.19 is required, and the Python SDK requires Python ≥ 3.10. Unknown effects still require human reconciliation before resume. Skill loading and tool discovery grant no new permissions. Real external authorization-server interoperability and global paired performance gains are not certified.

A configurable Provider is not certified; qualification requires strict-provider evidence for the same version, commit, and Runtime digest. Maintainers can follow the [RC acceptance guide](/release/RC-ACCEPTANCE.en) and [release SOP](/release/README.en).
