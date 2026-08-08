# Configuration

`coremind.yaml` is the executable contract for one agent project. It describes intent, provider selection, tools, permissions, budgets, recovery, and quality requirements in one reviewable file.

## Minimal configuration

```yaml
version: "1"
agent:
  name: assistant
  instructions: |
    Answer accurately. State uncertainty and never invent tool results.
model:
  provider: openai
  id: gpt-5
permissions:
  mode: ask
```

Keep the first configuration small. Add tools and workflow stages only when a verified requirement needs them.

## Environment substitution

Secrets belong in environment variables, not YAML:

```yaml
model:
  provider: openai
  id: gpt-5
  apiKey: ${OPENAI_API_KEY}
```

Validation reports a missing variable before execution. Do not place fallback secrets in the file.

## Permission modes

| Mode | Meaning | Recommended use |
| --- | --- | --- |
| `ask` | Request approval for protected actions | Default for development and unfamiliar projects |
| `auto-approve` | Approve actions allowed by declared policy | Controlled automation with reviewed tools |
| `full-access` | Allow all configured actions | Isolated environments only |

Permission mode does not make unsafe tools safe. Each custom tool must still validate input, limit scope, and report side effects.

## Budgets and loop boundaries

Declare limits for model turns, tool calls, elapsed time, and token or cost budgets where available. A bounded loop must end with a structured reason: success, quality rejection, budget exhaustion, denial, or unrecoverable error.

## Tools

Enable the smallest set needed by the task. Give each tool a clear schema and description. Separate read-only tools from tools that write files, execute commands, contact external services, or affect other people.

## Quality gates

Quality checks should be observable and repeatable. Examples include schema validation, required citations, test execution, maximum unresolved issues, or a business-specific score threshold. A gate failure must not be rewritten as success.

## Validate changes

```bash
npx coremind check
npx coremind run coremind.yaml --dry-run
```

Commit configuration changes together with the tests or examples that demonstrate the intended behavior.
