---
name: project-agent
description: "Develop and verify the Verified Repair Loop CoreMind golden example. Use when adapting this example, its business rules, tools, workflow, evaluation, or failure cases."
---

# Verified Repair Loop

1. Read ../../docs/requirements.en.md and ../../docs/architecture.en.md.
2. Keep the example offline until the owner explicitly approves real data egress.
3. Change one confirmed business rule at a time and add its scenario first.
4. Preserve the repair-success, pause-resume, and exhaustion scenarios before implementation changes.
5. Run CoreMind check, the automated test, and evaluation.
6. Inspect RunOutcome, ordered Loop states, budgets, Trace, effect receipts, and checkpoints; do not accept fluent text alone.
7. Stop before any unconfirmed production integration, irreversible action, push, tag, or publish.
