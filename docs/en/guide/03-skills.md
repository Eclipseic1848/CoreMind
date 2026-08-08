# Skills

A Skill is a reusable operating guide for a focused capability. It tells an agent when to apply a workflow, what evidence to collect, which steps to execute, and when to stop for human input.

## When to create a Skill

Create one when a procedure is repeated, failure-prone, or requires domain rules that do not belong in the global prompt. Do not create a Skill for a one-line preference or a single-use task.

## Required structure

Each Skill uses a `SKILL.md` entry point with concise metadata and complete instructions. Keep the main path readable; place large references, scripts, and examples in dedicated folders only when they are actually needed.

## Writing rules

1. Name the trigger conditions precisely.
2. Define inputs, outputs, safety boundaries, and completion criteria.
3. Use ordered, executable steps.
4. Separate facts from suggestions and generated content.
5. Include failure handling and human approval points.
6. Validate the Skill against at least one realistic example.

## Module relationship

CoreMind modules provide README, GUIDE, SOP, Skill, tests, and a changelog as one learning unit. The README explains purpose, the guide teaches concepts, the SOP gives the operational checklist, and the Skill makes that procedure reusable by an agent.

Start with the generated module closest to your task, then adapt business rules without weakening its permission or quality boundaries.
