# Deploy and restore optional CoreMind components

Start a business project with the CoreMind 2.2.0 [minimal Runtime configuration](../../docs/en/guide/06-capability-construction.md#start-in-your-own-project). Omit component MCP bindings and leave their services stopped for a Runtime-only project. Give each selected component its own Python environment and application directory. After its probes pass, bind the endpoint and reader token to the agent that needs it.

| Selection | Pinned stack and readiness check | Data to retain |
| --- | --- | --- |
| Knowledge | Knowledge wheel 0.1.1, pinned BGE-M3 ONNX weights, and Qdrant Client 1.15.1. Probe authenticated `/health`, then search and resolve a permitted citation. [Deployment and recovery](../modules/manage-knowledge/deployment/README.en.md) | Manifest, originals, version catalog, and withdrawals. The in-memory index rebuilds from this data. |
| Hindsight memory | Gateway 0.1.1, Hindsight 1.2.3, and PostgreSQL 18.1. Check the database and Hindsight `/health/ready`, then recall a confirmed fact through the gateway. [Current installation](../../components/memory/README.md) · [0.1.0 recovery replay](../modules/manage-memory/deployment/README.en.md) | PostgreSQL logical backup, host bindings, and latest receipts. Consumers receive only their reader tokens. |
| Ontology | Ontology wheel 0.1.1 with RDFLib 7.6.0 and pySHACL 0.40.2. Probe `/health`, then query an object and check the model version. [Current installation](../../components/ontology/README.md) · [0.1.0 recovery replay](../modules/manage-ontology/deployment/README.en.md) | Model, instances, mappings, shapes, and action definitions. When actions are enabled, retain receipts and authoritative business records too. |

The samples use host Python environments and upstream PostgreSQL tools, with component ports `8767`, `8769`, and `8879` on loopback. The host selects Hindsight's model endpoint and weights, and controls what data is sent there. Synthetic acceptance uses a deterministic local model and pre-provisioned weights. [Hindsight self-hosted installation](https://hindsight.vectorize.io/developer/installation)

1. **Runtime only.** Run a minimal project and check its tool catalog and call count. With no bindings, keep all three services stopped.
2. **Enable selected components.** Start and probe each selected service as documented. Bind one component first, and check the passage, fact source, or model version before combining components. Give read-only callers their corresponding reader token.
3. **Stop and recover.** Remove project bindings before stopping project-owned processes and retaining their data. Pause writes and back up each component as documented. In a fresh directory or database, verify the restore before exposing it to business traffic. Preserve the latest forgetting receipts. Use authoritative business records for unknown action outcomes. Roll back applications using a verified environment and compatible data. Record startup time, recovery time, and backup size.

## Run the composition check outside the checkout

Create two empty npm projects and one Python 3.12 environment outside the checkout. Install the pinned npm packages `coremind-ai@2.2.0` and `coremind-cli@2.2.0` and Python `coremind-ai==2.2.0`. Use absolute paths and run from the checkout root. Keep the three services stopped for the first pass to check the Runtime, a Skill, and a local tool without component bindings.

```sh
node scripts/verify-optional-consumer.mjs "<external npm project>" "<Python interpreter>"
```

After deploying the services individually, copy [services.example.json](services.example.json) to a private directory and supply your loopback endpoints, reader credentials, test inputs, and expected results. Use the memory deployment procedure to retain a synthetic fact first. Run with the second npm project to check the services individually, together, and after removing all bindings.

```sh
node scripts/verify-optional-consumer.mjs "<another npm project>" "<Python interpreter>" "<private service configuration JSON>"
```

The script drives the CLI, TypeScript, and synchronous and asynchronous Python with a deterministic local model. It records tool catalogs, calls, and results in `optional-acceptance.json`. Component deployment examples exercise backup and recovery separately.
