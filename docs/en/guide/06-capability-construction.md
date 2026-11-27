# Build an agent from the capability map

[简体中文](../../guide/06-capability-construction.md)

Domains 04–08 of the V1.0.2 agent capability map cover 20 capabilities. The project owner supplies documents, identities, business rules and acceptance cases. CoreMind supplies the modules. The TypeScript SDK, CLI with YAML, and synchronous and asynchronous Python SDKs share one Node Runtime. Each module has an implementation SOP, a reusable developer Skill and an example with configuration, commands and expected results.

## Start in your own project

Create `coremind.yaml` in your application directory with a provider and one agent. This minimal CoreMind 2.2.0 configuration runs the Runtime on its own.

```yaml
schemaVersion: 2
name: my-project
provider:
  id: deepseek
  model: deepseek-flash
  apiKeyEnv: DEEPSEEK_API_KEY
agents:
  main:
    systemPrompt: Answer questions using the text supplied by the user.
```

Supply the model credential through the environment. From this directory run `npx coremind-cli@2.2.0 run coremind.yaml --prompt "Reply only OK"` and check the reply and zero tool calls. Keep the configuration and dependency versions for comparison when you enable each capability.

To generate the configuration, run `npx coremind-cli@2.2.0 create . --runtime-only --provider deepseek --model deepseek-flash`. It preserves an existing `coremind.yaml`. [Upgrade and rollback](../../migrations/2.1-to-2.2.en.md) · [Minimal SDK examples](../../../examples/modules/configure-coremind/README.en.md)

Use a separate Python environment for each knowledge, memory or ontology service you choose.

| Select one capability | How to connect it in 2.2.0 | First acceptance check |
| --- | --- | --- |
| Knowledge | Run `python -m pip install coremind-knowledge-mcp==0.1.1`, deploy the knowledge MCP service and bind only the retrieval operations the agent needs | Supply two source versions, then search as a reader and resolve the citation and version |
| Hindsight memory | Run `python -m pip install coremind-memory-mcp==0.1.1`, start the gateway, bind a Hindsight bank and authorize recall separately | Retain a confirmed preference as the host, recall it in a new session and verify another subject cannot read it |
| Skill | Define a method in `skills/<id>/SKILL.md` and select its ID in `agents.main.skills`. For cross-project installation, use `coremind-skill-install` from `coremind-templates@2.2.0` | Load the body for a matching task, remove the ID and verify that a new run cannot load it |
| Tools | Register a business function through the 2.2.0 SDK or bind a stdio/HTTP MCP operation, then select the tool for the agent | Verify input, permission and a business receipt. Remove the binding and check the tool catalog in a new run |
| Ontology | Run `python -m pip install coremind-ontology-mcp==0.1.1`, supply the model, mappings and constraints, then bind the required ontology MCP operations | Validate one conforming and one violating record against your model. Grant read-only projects query and validation operations |

Knowledge, memory and ontology use the Runtime's MCP interfaces. CoreMind 2.0.0 delivered these services and adapters as source examples. Version 2.1.0 provides separate PyPI packages. Each component includes its implementation, version and compatibility range, SOP, developer Skill and a runnable example that enables only that capability. [Knowledge service](../../../components/knowledge/README.md) · [Memory gateway](../../../components/memory/README.md) · [Ontology service](../../../components/ontology/README.md) · [Roadmap](../../roadmap.en.md)

**Acceptance from an empty project**

1. Run the Runtime in a project outside the repository. Keep the output and verify that no optional service, business Skill or business tool was loaded.
2. Return to this baseline for each capability. Record enabling it, calling it and removing it. Supply only its own dependencies, configuration, data and credentials. Upgrade or roll it back while checking host state and the other components' versions.
3. Combine capabilities needed for a task, such as knowledge and a Skill. Remove one and check the other still works. Use the same project configuration for the CLI, TypeScript, synchronous Python and asynchronous Python entry points.

`document-assistant` is a reference example and a regression test for composition. The following results are from 2.0.0. Seven cases ran in two projects with synthetic documents, live Qwen, Qdrant/BGE-M3, Hindsight/PostgreSQL and an optional ontology. The inputs, permissions, expected outputs and failure records can help you design your own tests. [Composition example](../../../examples/modules/manage-ontology/README.en.md) · [Live service integration](../../../examples/modules/manage-ontology/LIVE-COMPOSITION.en.md)

Application code can query the selected component through standard MCP, then pass the same endpoint and reader token to an Agent. The two empty project examples cover knowledge search and citation lookup in TypeScript and Hindsight recall in Python. [TypeScript knowledge example](../../../examples/modules/manage-knowledge/README.en.md#query-directly-from-an-empty-typescript-project) · [Python memory example](../../../examples/modules/manage-memory/README.en.md#recall-directly-from-an-empty-python-project)

### Repeat the installed consumer checks

[The optional component deployment and recovery example](../../../examples/optional-components/README.en.md) gives the pinned versions, startup order, data to retain, recovery drills, and the check for using all three services together.

External projects installed 2.2.0 from public npm and PyPI and passed the 17-check baseline and the 57-check component matrix. The CLI, TypeScript, and both Python entry points exercised knowledge, memory, and ontology together. After removing the components, all four entry points made zero tool calls. Both checks used synthetic inputs and a local model fixture.

The external consumer passed 49 checks with packages built from the frozen 2.1.0 commit. The checks cover the baseline, all five individual capabilities, combinations and removal. Use the same script to verify the public packages. [Frozen artifact acceptance](https://github.com/Eclipseic1848/CoreMind/issues/426) · [Publication and reinstall](https://github.com/Eclipseic1848/CoreMind/issues/427)

Create a consumer outside the checkout and pin `coremind-cli@2.2.0`, the TypeScript `coremind-ai@2.2.0` package and Python `coremind-ai==2.2.0` with its bundled Worker. Install and start the three services in separate Python environments as shown above. A private JSON file uses the keys `knowledge`, `memory` and `ontology`. For each service, provide its loopback `url`, read `authorization`, read-only `tool`, `args` and an expected response substring in `expect`. Retain a synthetic fact as the host for the memory case, then run the [acceptance script](../../../scripts/verify-optional-consumer.mjs) from the repository.

```sh
node scripts/verify-optional-consumer.mjs <consumer-directory> <Python-with-installed-SDK> <private-JSON>
```

The script writes `optional-acceptance.json` with the catalog and successful calls observed through each of the four entry points. The model is a deterministic local fixture. The three MCP services run from installed artifacts. Omit the private JSON argument to repeat the Runtime, Skill and tools cases.

## 04 Knowledge management

[Implementation SOP](../../modules/manage-knowledge/SOP.en.md) · [Developer Skill](../../../skills/manage-knowledge/SKILL.md) · [Runnable example and retrieval results](../../../examples/modules/manage-knowledge/README.en.md)

| Capability | Entry point and evidence | What the project owner supplies or verifies |
| --- | --- | --- |
| 04.01 Ingest and parse documents | `docling_bridge.py` uses Docling and RapidOCR with native and scanned Chinese PDF pages, DOCX tables and Markdown. It retains the page, section or source location available for each format. | Supply originals and expected cells, passages or pages. Check locator precision separately for each format. |
| 04.02 Organize and index knowledge | `knowledge_server.py --state` retains document identity and version. Repeated imports are idempotent, conflicting bytes under the same version are rejected, and a failed rebuild retains the old index. | Supply a manifest, stable IDs, versions, validity and reading scope. Source builds can [opt in to persistent Qdrant](../../modules/manage-knowledge/GUIDE.en.md#opt-in-to-a-persistent-qdrant-index). |
| 04.03 Rank and retrieve evidence | `search_knowledge` searches within the reader scope chosen by the host. Keyword, dense, sparse and hybrid methods each placed the expected evidence in the top five for 30/30 synthetic Chinese questions. Sparse retrieval ranked it first for 30/30. | Include paraphrases, exact identifiers, forbidden documents and unanswerable questions. Score answers and citations separately from retrieval. The four-entry comparison drives real retrieval with a model fixture. |
| 04.04 Update sources and resolve citations | The host withdraws a version with `--withdraw`, and new searches exclude it. The current source resolves specific PDF and DOCX excerpts by `chunkId` and returns `ambiguous` when a legacy page or section matches multiple excerpts. [Integration guide](../../modules/manage-knowledge/GUIDE.en.md) | Define replacement, withdrawal authority and retention. After each rebuild, check old and new citations and compare the search and lookup text for excerpts on the same page or in the same section. |

## 05 Memory management

[Implementation SOP and evidence](../../modules/manage-memory/SOP.en.md) · [Developer Skill](../../../skills/manage-memory/SKILL.md) · [Runnable example](../../../examples/modules/manage-memory/README.en.md)

| Capability | Entry point and evidence | What the project owner supplies or verifies |
| --- | --- | --- |
| 05.01 Session and long-term memory | CoreMind retains session state. Hindsight 1.2.3 with PostgreSQL stores long-term memory. Reader bindings were exercised across new sessions and across project, principal, agent and branch boundaries. | Decide which sessions may share a bank. Supply separate credentials and out-of-scope cases. |
| 05.02 Write and recall | The host uses the `retain` admin operation for confirmed facts. The agent uses `recall_memory`. Repeated writes used a stable document ID and expected version. All four entry points recalled the same active version. | Supply the source, document ID, approver and expiry. Keep management credentials with the host. |
| 05.03 Derive and review experience | `reflect` produces a candidate for review. On five synthetic cases, live `deepseek-flash` produced candidates in all three with direct evidence and declined both missing-evidence cases. Confirmation and withdrawal control future visibility. | Define admissible evidence, conditions, counterexamples and who may confirm. Measure incorrect derivation and adoption on business cases. |
| 05.04 Correct and forget | Correction, expiry and forgetting limit recall to active versions. After a PostgreSQL logical restore, the latest forgetting receipt blocked old content. Replaying deletion removed derived Hindsight records. | Set retention, deletion ownership and replay order. Verify physical backups, point-in-time recovery and media disposal on the deployed system. |

## 06 Ontology modeling (optional)

[Implementation SOP and evidence](../../modules/manage-ontology/SOP.en.md) · [Developer Skill](../../../skills/manage-ontology/SKILL.md) · [Runnable example and model bundles](../../../examples/modules/manage-ontology/README.en.md)

| Capability | Entry point and evidence | What the project owner supplies or verifies |
| --- | --- | --- |
| 06.01 Model objects and relationships | `ontology_describe` uses RDFLib to read types, attributes and relationships. Document and equipment models use the same adapter. All four entry points exercised enabled, disabled and broken-model configurations. | Supply reviewed `model.ttl` and `data.ttl`. Test a second domain vocabulary with the same adapter. |
| 06.02 Align business concepts | `ontology_validate_record` normalizes identifiers, fields, codes and units via `mapping.json`. Conflicts and ambiguity return `needs_confirmation`. Original values and the mapping version are retained. | Supply mappings and records with ambiguous names. Assign a reviewer for unresolved cases. |
| 06.03 Validate rules and constraints | pySHACL runs the rules in `shapes.ttl`. Checks exercise compliant input, violations and engine unavailability. Violation reports identify the object, path, rule and explanation. | Supply business shapes and both valid and violating instances. Record model and shape versions for reproduction. |
| 06.04 Bind business actions | `ontology_inspect_action` and `ontology_perform_action` check the starting state, permissions and expected result. Tests cover zero executions on denial, reading a confirmed receipt again, and blocking duplicate writes to a target after a lost receipt. | Supply `actions.json`, a real handler, durable request IDs and business-system receipts. The demonstration handler runs in process. |

## 07 Tool integration

[Implementation SOP and evidence](../../modules/build-tools/SOP.en.md) · [Developer Skill](../../../skills/build-tools/SKILL.md) · [Runnable example](../../../examples/modules/build-tools/README.en.md)

| Capability | Entry point and evidence | What the project owner supplies or verifies |
| --- | --- | --- |
| 07.01 Register and discover tools | Register a business function with `defineTool` or select tools for an agent in configuration. Deferred loading uses `discover_tools`. Check catalog visibility, approval and invocation separately. [Configuration guide](02-configuration.md) | Supply IDs, descriptions, inputs and authorization scope. Test visibility and invocation with an unauthorized agent. |
| 07.02 Adapt interfaces and protocols | `transport-parity.mjs` drives a local handler, real stdio MCP and loopback HTTP MCP with a deterministic model. On Windows and Linux the same input preserved `false`, `0` and `null` in all three results. | Replace the handler, launch command or fixed endpoint and credentials. Exercise timeouts, cancellation and disconnects on your service. |
| 07.03 Validate tool calls and outcomes | Input validation accepts draft-07 and explicit Draft 2020-12 and rejects unknown dialects. A disconnect after a write retains an `unknown` effect. Tests check that cold recovery does not repeat the write. | Supply an input schema, business success criteria and an idempotency key. Look up unknown effects in the business system. |
| 07.04 Browser and code execution | Optional Playwright MCP exercised filtering, screenshots, CSV and cleanup after cancellation on Windows Chrome 157. Linux container tests checked command output, timeouts and process-tree cleanup. [Browser acceptance](../../modules/build-tools/BROWSER.en.md) | Specify authorized pages, paths and commands. Repeat the checks on the target OS and browser version. |

## 08 Skill development

[Implementation SOP and evidence](../../modules/package-agent-skills/SOP.en.md) · [Developer Skill](../../../skills/package-agent-skills/SKILL.md) · [Runnable example and evaluation inputs](../../../examples/modules/package-agent-skills/README.en.md)

| Capability | Entry point and evidence | What the project owner supplies or verifies |
| --- | --- | --- |
| 08.01 Author and generate Skills | `draft-skill.mjs` produces an editable standard `SKILL.md` from a task description. It refuses to overwrite an existing ID. The regression uses the real loader to check human edits and explicit selection. | Supply the task description, positive and negative trigger conditions, and expected output. After review, copy the draft into the project and select its ID for the agent. [Authoring guide](../../modules/package-agent-skills/GUIDE.en.md) |
| 08.02 Discover and load Skills | The Runtime first exposes an index. `load_skill({id})` loads an authorized body on demand. Four entry points ran five deterministic cases against two Skills. Ordinary summaries made no Skill calls, and cold recovery retained the frozen version. | Describe the differences between similar Skills and prepare cases that should and should not trigger each one. |
| 08.03 Reuse methods and resources | `load_skill({id, resource})` reads a declared file that matches its digest. Two tasks reused the weekly template. Reading script source left the execution sentinel absent. | Supply templates, references and resource digests. Register a separately authorized tool to execute a script. |
| 08.04 Validate and share Skills | Two clean projects installed the pinned Git source and reproduced it from the lock. The initial live Qwen paired evaluation scored 3/5 enabled and 1/5 disabled. After the output instructions changed, the two targeted cases scored 2/2 and 0/2. | Pin the source, version and content. Verify upgrades and rollback. Evaluate triggers and outcomes on business cases with the same scoring rules. |

## 12 Outcome evaluation and regression

Run the [offline regression for the five capabilities](../../../examples/modules/evaluate-agents/README.en.md#offline-regression-for-the-five-optional-capabilities) and save the JSON report as you enable capabilities. Replace the synthetic cases with held-out business cases and approved evidence to evaluate knowledge retrieval and citations, experience adoption, Skill misfires and costs, and actual tool and ontology receipts. [Evaluation SOP](../../modules/evaluate-agents/SOP.en.md#regression-for-the-five-optional-capabilities)
