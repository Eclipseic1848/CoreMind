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

## Project status

The `0.7.1` stable release line has completed code and documentation preparation. It hardens credential Headers, Artifact import, incremental Fact persistence, long-lived Workers, TUI input, and release-failure evidence on top of Protocol v2, unified security and error contracts, and Child Runs. Use the live GitHub Release, npm, and PyPI pages as the source of truth for public installability. Review the [public roadmap](/roadmap.en), [quality guide](/en/guide/04-quality), and [provider matrix](/providers/README.en) before adoption.

The checked-in Provider ledger currently has no static `0.7.1` certification record. Formal publication requires a strict-provider workflow Artifact bound to the candidate commit and Runtime digest. Configurability is not certification; production evaluation must check both the provider matrix and this version's workflow evidence. Maintainers can follow the [RC acceptance guide](/release/RC-ACCEPTANCE.en) and [release SOP](/release/README.en).
