# Quick Start

This guide creates and runs a minimal CoreMind project. CoreMind currently requires Node.js 22.19 or later. Python embedding requires Python 3.10 or later.

## 1. Choose your language

When creating a project, choose TypeScript, JavaScript, or Python. TypeScript is recommended for first-time users because configuration and SDK calls receive the strongest editor feedback.

## 2. Install and create a project

```bash
npm install coremind-ai coremind-cli
npx coremind create my-agent
cd my-agent
```

Select a template, language, and permission mode when prompted. The generated project contains configuration, environment examples, tests, and local operating instructions.

## 3. Configure credentials

Copy `.env.example` to `.env` and add only the credential required by your selected provider. Never commit `.env`.

```dotenv
OPENAI_API_KEY=replace_me
```

Provider support does not imply live certification. Check the [provider matrix](/providers/README.en) before production evaluation.

## 4. Validate before running

```bash
npx coremind doctor
npx coremind check
npx coremind run coremind.yaml --dry-run
```

`doctor` checks the environment, `check` validates the project contract, and `--dry-run` resolves configuration without sending a model request.

## 5. Run interactively

```bash
npx coremind chat coremind.yaml
```

Start with the ask permission mode. Review every requested operation until you understand the tool and data boundaries.

## Next steps

- Learn the [configuration model](/en/guide/02-configuration).
- Add reusable instructions through [Skills](/en/guide/03-skills).
- Define [quality gates](/en/guide/04-quality).
- Explore the complete [CLI reference](/en/guide/05-cli-usage).
