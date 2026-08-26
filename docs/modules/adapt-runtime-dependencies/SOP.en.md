# Runtime Dependency Upgrade and Rollback SOP

## Preconditions

Read the [module contract](README.en.md) and copy the [dependency upgrade spike template](DEPENDENCY-UPGRADE-SPIKE-TEMPLATE.en.md). Fix the reference version, candidate version, affected seams, migration scope, and rollback point. Live-provider calls, cost, or code egress require separate authorization.

## Procedure

1. Run `npm run build`, `npm run baseline:check`, and `npm run dependencies:check` for pre-change evidence.
2. Write failing tests for version uniqueness and every affected behavior.
3. Set every critical dependency to the same exact version and refresh the lockfile with `npm install --ignore-scripts`.
4. Convert messages, tools, usage, and errors inside private adapters. Do not add low-level version fields to Config.
5. Run Provider streaming/tool/abort/usage/error/timeout, Session roundtrip, and tool contract tests.
6. Build the public declaration rollups and verify that the Runtime and unified SDK roots expose only CoreMind-owned message, tool, and result contracts.
7. Regenerate the Provider matrix and dependency report. New catalog entries remain configurable and unverified.
8. Document Session/API migration and whole-family rollback before updating the candidate baseline with an explicit reason.
9. Run Windows/Linux install, build, package, CLI, and Python Worker smoke tests.
10. Synchronize README, Guide, SOP, Skill, examples, and Changelog, then run documentation gates.

## Rollback

Restore all three critical packages to one prior version, restore the lockfile and Session adapter, rebuild, and rerun the reference cases. Never roll back only one package.

## Stop conditions

Stop on unexplained message loss, changed tool arguments, incorrect usage accounting, lossless-Session recovery failure, or a security-gate failure. Do not continue through a type cast.
