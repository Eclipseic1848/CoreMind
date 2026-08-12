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

The current code version is `0.3.0-rc.2`. Use Releases and registries as the source of truth for installable availability; the source remains available for review and community development. Review the [public roadmap](/roadmap.en), [quality guide](/en/guide/04-quality), and [provider matrix](/providers/README.en) before adoption.

Every prerelease candidate must complete the Windows/Linux P01-P19 automated matrix, real pseudoterminal acceptance on both platforms, a current live-provider recheck, and the final documentation audit on the same commit. Use [GitHub Releases](https://github.com/Eclipseic1848/CoreMind/releases), npm, and PyPI as the source of truth for public availability; maintainers can follow the [RC acceptance guide](/release/RC-ACCEPTANCE.en) and [release SOP](/release/README.en).
