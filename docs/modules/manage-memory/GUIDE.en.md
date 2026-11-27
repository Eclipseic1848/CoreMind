# Integrate long-term memory

## Connect one component in an empty project

Run `python -m pip install coremind-memory-mcp==0.1.1` on the host and launch the gateway as described in the [example](../../../examples/modules/manage-memory/README.en.md). A standard MCP client can connect directly. For CoreMind, install the CLI and TypeScript SDK in the application with `npm install --save-exact coremind-cli@2.2.0 coremind-ai@2.2.0`. Python projects run `python -m pip install coremind-ai==2.2.0` and use its bundled Worker. The following `coremind.yaml` registers one tool. Select an application model configured by your host.

Copy the [empty Python project example](../../../examples/modules/manage-memory/README.en.md#recall-directly-from-an-empty-python-project). Recall through MCP with a reader token, then bind the same endpoint and token to an Agent. The host uses the gateway's administrative interface for confirmation, retention and correction.

For a host with its own PostgreSQL database, follow the [standalone deployment and recovery example](../../../examples/modules/manage-memory/deployment/README.en.md). It pins Hindsight and gateway versions, separates the database from gateway receipts, and tests recovery against a new database.

When upgrading from 2.0.0, keep the gateway configuration and repeat the checks in the [migration and rollback guide](../../migrations/2.0-to-2.1.en.md).

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

## Confirm and review an experience by evidence version

Use a gateway built from the current source. The host calls `/admin/reflect` to obtain a candidate, then checks its source text, applicability, and `candidate.based_on.memories`. After confirmation, send `/admin/retain` a `kind: "experience"` request with a readable `source` reference and a nonempty `evidence` array. Each entry supplies the `documentId` and current `version` in the same bank. An experience may cite multiple entries. Duplicate, self, and downstream references that the correction would invalidate are rejected. See the [runnable example](../../../examples/modules/manage-memory/README.en.md#experience-evidence-and-review).

When evidence is corrected or forgotten, the gateway marks affected experiences and their downstream dependants `pending_review` and excludes them from recall and reflection. The host posts `{"bankId":"demo-alice"}` to `/admin/review-status` and checks `pendingReview` for experience IDs, versions, and previous evidence. After review, call `/admin/correct` with the experience's current `expectedVersion`, the reviewed content, and valid evidence. Success creates a new visible version. An exact replay of the old write still returns `pending_review` while the experience awaits review.

Recall adds `evidence` to tracked experiences. The earliest applicable expiry among the experience and its evidence limits visibility. Existing experiences with a textual source remain compatible. Use a correction to add tracking after the host verifies the evidence.

## Walk through the memory lifecycle

Have the host confirm “prefer tables for document summaries” and grant sharing for that subject and agent. Ask in a new session which format to use. Check the recalled content, revision, source, and reason for the match. Repeat with another subject or a branch without a grant. The memory should be absent.

Correct the preference to “prefer lists for document summaries” and check that a new session uses the new value. Forget the memory and confirm that the service cannot recall it after restart. Session history and copies already shared with a model have their own retention policies. Handle those copies in the corresponding data domain. [Development SOP](SOP.en.md)
