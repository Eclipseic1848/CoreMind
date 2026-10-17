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

## Current release line: `1.2.0`

[Upgrade directly from 1.0.1](../migrations/1.0-to-1.2.en.md) · [1.2 release notes](../release/notes/v1.2.0.md)

> The `1.2.0` release line upgrades directly from `1.0.1` and includes unpublished 1.1 development: standard Skills, durable control, controlled MCP/explicit OAuth, discovery, and terminal evidence. It also includes Session, final tool-argument, model-request, custom-authentication, output-delivery, duplicate Call identity, journal-processing, Python notification-consumption, project-script loading-trust, and terminal-editing improvements. Live [GitHub Releases](https://github.com/Eclipseic1848/CoreMind/releases), [npm](https://www.npmjs.com/package/coremind-cli), and [PyPI](https://pypi.org/project/coremind-ai/) pages and same-commit qualification evidence determine public availability; source code and engineering CI do not establish publication.

- Standard `SKILL.md` indexing, on-demand loading, and frozen-snapshot recovery.
- Durable same-Run `/steer`, `/follow-up`, and five-state control receipts.
- Permission-gated local MCP stdio tools and cancellation settlement.
- Fixed HTTP MCP targets, exact resource authorization, and controlled credentials.
- Explicit host OAuth login, cancellation, exit, and logout.
- Explicit Config v3 `deferred` Chinese/English lexical discovery, declaration generation, and fact reconstruction.
- Terminal evidence per Run/Call, controlled Artifact references, and safe input.

Config v2, omitted or explicit `direct` tools, and Protocol v1 remain compatible; `deferred` requires explicit Config v3. New features require matching SDK and bundled Worker capabilities; Protocol v2 also requires matching Schema fingerprints. Node.js ≥ 22.19 is required, and the Python SDK requires Python ≥ 3.10. Unknown effects still require human reconciliation before resume. Skill loading and tool discovery grant no new permissions. Real external authorization-server interoperability and global paired performance gains are not certified.

A configurable Provider is not certified; qualification requires strict-provider evidence for the same version, commit, and Runtime digest. Maintainers can follow the [RC acceptance guide](/release/RC-ACCEPTANCE.en) and [release SOP](/release/README.en).
