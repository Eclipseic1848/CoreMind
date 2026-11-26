# Quick Start

This guide creates and runs a minimal CoreMind project. CoreMind currently requires Node.js 22.19 or later. Python embedding requires Python 3.10 or later.

## 1. Choose your language

When creating a project, choose TypeScript, JavaScript, or Python. TypeScript is recommended for first-time users because configuration and SDK calls receive the strongest editor feedback.

## 2. Install and choose a project entry point

For an existing project or an empty directory, use the [Runtime-only configuration](06-capability-construction.md) and enable one capability when needed. The CLI example below uses the translator template.

This guide uses `coremind-cli@2.1.0` from npm. For existing projects, follow the [2.0-to-2.1 upgrade and rollback guide](../../migrations/2.0-to-2.1.en.md). For earlier versions, see the [1.4-to-2.0 migration guide](/migrations/1.4-to-2.0.en) and [historical 1.0.1-to-1.2 guide](/migrations/1.0-to-1.2.en).

```bash
npm install --save-exact coremind-ai@2.1.0 coremind-cli@2.1.0
npx coremind-cli@2.1.0 providers
npx coremind-cli@2.1.0 create my-agent --template translator --language typescript --provider deepseek --model deepseek-flash
cd my-agent
```

Select a template, language, provider, and permission mode when prompted. Non-interactive scripts must provide `--provider`. The generated project contains configuration, environment examples, tests, and local operating instructions.

## 3. Configure credentials

Copy `.env.example` to `.env` and add only the credential required by your selected provider. Never commit `.env`.

```dotenv
DEEPSEEK_API_KEY=replace_me
```

Credentials belong in environment variables. An embedding host may instead supply a `SecretRef` resolver; sensitive Headers, including common API-key and token aliases, cannot use plaintext literals.

The example uses `deepseek-flash`, which passed strict certification for 2.1.0. Before production use, verify the Provider, model, credentials and deployment environment you will actually use. [Provider matrix](/providers/README.en) · [2.1.0 strict qualification](https://github.com/Eclipseic1848/CoreMind/actions/runs/45739932680)

## 4. Validate before running

```bash
npx coremind-cli@2.1.0 doctor coremind.yaml
npx coremind-cli@2.1.0 check coremind.yaml
```

`doctor` reports the environment and `check` validates the project configuration. You can run both checks before sending a model request.

## 5. Run interactively

```bash
npx coremind-cli@2.1.0 chat coremind.yaml
```

Start with the ask permission mode. Review every requested operation until you understand the tool and data boundaries.

## Next steps

- Learn the [configuration model](/en/guide/02-configuration).
- Add reusable instructions through [Skills](/en/guide/03-skills).
- Define [quality gates](/en/guide/04-quality).
- Explore the complete [CLI reference](/en/guide/05-cli-usage).
- Combine knowledge, memory, ontology, tools and Skills for a business task with the [capability construction and acceptance guide](06-capability-construction.md).
