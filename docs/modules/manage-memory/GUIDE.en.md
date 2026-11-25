# Integrate long-term memory

## Connect one component in an empty project

Run the 2.0.0 source gateway in a separate service directory as described in the [example](../../../examples/modules/manage-memory/README.en.md). A standard MCP client can connect directly. For CoreMind, install the CLI and TypeScript SDK in the application with `npm install --save-exact coremind-cli@2.0.0 coremind-ai@2.0.0`. Python projects install `coremind-ai==2.0.0` and use its bundled Worker. The following `coremind.yaml` registers one tool. Select an application model configured by your host.

```yaml
schemaVersion: 3
name: memory-client
provider: { id: deepseek, model: deepseek-flash, apiKeyEnv: DEEPSEEK_API_KEY }
defaultAgent: main
mcp:
  servers:
    memory:
      transport: streamable-http
      url: http://127.0.0.1:8769/mcp
      allowedAddresses: ["127.0.0.1"]
      headers: { Authorization: { env: COREMIND_MEMORY_AUTHORIZATION } }
agents:
  main:
    systemPrompt: Use recall_memory for confirmed facts and include the source and version.
    tools:
      - mcp: { server: memory, tool: recall_memory }
        effect: { operations: [network], reversible: true }
        capability: { effect: network, replay: safe, concurrency: run_serial, checkpoint: none, durability: critical }
permissions: { mode: ask, network: allow, workspaceOnly: true }
runtime: { maxTurns: 3, maxToolCalls: 4, maxRetries: 0 }
quality: { profile: development }
```

In the application terminal, supply the configured model credential and set `COREMIND_MEMORY_AUTHORIZATION` to its host-issued `Bearer …` reader token before running `npx --no-install coremind check coremind.yaml`. A blank project uses the development profile, which reports missing project materials as warnings. Keep the bank bindings, administrator token, Hindsight API key, database and receipts in the service environment. The gateway binds to loopback. For clients on other machines, the host provides an authenticated service endpoint and configures the matching URL and address allowlist.

## Establish read and write access

1. Have the host determine the project, subject, and agent. Keep memories in their session branch or grant sharing across sessions explicitly. Bind access independently for new and forked sessions. Keep the session and entry in the source reference, with the source branch when it matters.
2. Have the host manage the Hindsight service and its persistent storage. Keep storage outside the agent's readable workspace. Give the agent access to the read-only MCP tool and keep writes and confirmation in the host's administration interface.
3. Define which materials may be used for candidate extraction. Include evidence, applicable conditions, and verifiable counterexamples or limitations. Have a confirmer review the proposed content before publication. Configure model and network access for the application.

## Walk through the memory lifecycle

Have the host confirm “prefer tables for document summaries” and grant sharing for that subject and agent. Ask in a new session which format to use. Check the recalled content, revision, source, and reason for the match. Repeat with another subject or a branch without a grant. The memory should be absent.

Correct the preference to “prefer lists for document summaries” and check that a new session uses the new value. Forget the memory and confirm that the service cannot recall it after restart. Session history and copies already shared with a model have their own retention policies. Handle those copies in the corresponding data domain. [Development SOP](SOP.en.md)
