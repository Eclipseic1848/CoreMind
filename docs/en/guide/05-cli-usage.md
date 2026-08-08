# CLI Reference

The CLI provides project scaffolding, environment checks, static validation, interactive chat, one-shot execution, evaluation, and template discovery.

## Commands

```bash
coremind create <directory>
coremind doctor
coremind check [config]
coremind run [config] [prompt]
coremind chat [config]
coremind eval [config]
coremind list-templates
```

Use `npx coremind-cli` before global installation, or invoke `coremind` after installing the CLI package globally.

## Recommended first run

```bash
npx coremind-cli doctor
npx coremind-cli check coremind.yaml
npx coremind-cli run coremind.yaml --dry-run
npx coremind-cli chat coremind.yaml
```

This sequence separates environment, configuration, resolution, and live execution failures.

## `create`

Creates a project from a maintained template. The wizard asks for language and permission mode, then writes the configuration, environment sample, tests, and local guidance. Existing non-empty targets are rejected unless the command explicitly supports safe reuse.

## `doctor`

Checks Node.js, configuration visibility, credentials, platform capabilities, and common installation problems. A successful result confirms prerequisites, not live provider behavior.

## `check`

Validates configuration and project contracts without contacting a model. Use it in local hooks and CI.

## `run`

Executes a single request and exits with a structured result. Use `--dry-run` to inspect resolved settings without model traffic. Automation should consume the documented result fields and process exit code rather than parsing decorative terminal text.

## `chat`

Starts the terminal interface with streaming output, approval requests, session controls, and trace visibility. Use `ask` mode while learning or reviewing a new repository.

Use `/abort` to stop the active response. To persist a named session, enable it in `coremind.yaml` before passing `--session`:

```yaml
session:
  enabled: true
  dir: ./sessions
```

```bash
coremind chat coremind.yaml --session work-1
```

Both `chat` and `run` fail with a configuration hint if `--session` is provided without `session.enabled: true`; the session identifier is never silently ignored.

## `eval`

Runs declared evaluation cases and reports gate results. Keep evaluation datasets free of secrets and record provider/model versions for reproducibility.

## Troubleshooting order

1. Run `doctor`.
2. Run `check` on the exact configuration path.
3. Run with `--dry-run`.
4. Inspect the structured error and trace identifier.
5. Reproduce with the smallest configuration before reporting an issue.

When filing a bug, include the CoreMind version, operating system, Node.js version, command, redacted configuration, expected behavior, actual behavior, and a minimal reproduction. Never include API keys.
