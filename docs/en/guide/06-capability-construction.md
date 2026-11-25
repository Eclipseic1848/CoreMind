# Build an agent from the capability map

[简体中文](../../guide/06-capability-construction.md)

Domains 04–08 of the V1.0.2 agent capability map cover 20 capabilities. The project owner supplies documents, identities, business rules and acceptance cases. CoreMind supplies the modules. The TypeScript SDK, CLI with YAML, and synchronous and asynchronous Python SDKs share one Node Runtime. Each module has an implementation SOP, a reusable developer Skill and an example with configuration, commands and expected results.

## Start with one business task

1. Choose a task with an observable result. For a document assistant, supply two versions of a document and a confirmed formatting preference. Require a summary with versioned citations. Include a withdrawn document and a reader without access.
2. Connect read-only knowledge and check that all four entry points return the same source passage. When the preference must carry over to another session, connect Hindsight and grant separate read and management permissions.
3. Put the summarization procedure in a Skill. Register actions such as saving the summary as tools. The host selects the authorized operator, the output directory and the receipt that proves completion.
4. Enable ontology when the task depends on object relationships or action prerequisites. Request publication for both a draft and a reviewed document. Check the executor call count on denial and the business receipt on success.
5. Use three independent sessions to exercise first use, preference reuse, and a correction combined with a source withdrawal. The composition example uses real MCP, Skill loading, file tools and the ontology engine. The knowledge index, memory backend and model are deterministic fixtures. Repeat the cases with the target services, model, installed artifacts and business samples before deployment. [Composition example](../../../examples/modules/manage-ontology/README.en.md)

## 04 Knowledge management

[Implementation SOP](../../modules/manage-knowledge/SOP.en.md) · [Developer Skill](../../../skills/manage-knowledge/SKILL.md) · [Runnable example and retrieval results](../../../examples/modules/manage-knowledge/README.en.md)

| Capability | Entry point and evidence | What the project owner supplies or verifies |
| --- | --- | --- |
| 04.01 Ingest and parse documents | `docling_bridge.py` uses Docling and RapidOCR with native and scanned Chinese PDF pages, DOCX tables and Markdown. It retains the page, section or source location available for each format. | Supply originals and expected cells, passages or pages. Check locator precision separately for each format. |
| 04.02 Organize and index knowledge | `knowledge_server.py --state` retains document identity and version. Repeated imports are idempotent, conflicting bytes under the same version are rejected, and a failed rebuild retains the old index. | Supply a manifest, stable IDs, versions, validity and reading scope. The example rebuilds the in-process Qdrant index from state and source files after restart. |
| 04.03 Rank and retrieve evidence | `search_knowledge` searches within the reader scope chosen by the host. Keyword, dense, sparse and hybrid methods each placed the expected evidence in the top five for 30/30 synthetic Chinese questions. Sparse retrieval ranked it first for 30/30. | Include paraphrases, exact identifiers, forbidden documents and unanswerable questions. Score answers and citations separately from retrieval. The four-entry comparison drives real retrieval with a model fixture. |
| 04.04 Update sources and resolve citations | The host withdraws a version with `--withdraw`. New searches exclude it. `resolve_citation` distinguishes available, withdrawn and unknown citations. A clean install from fixed source verified two rebuilds from originals. [Consumer acceptance](../../modules/manage-knowledge/CLEAN-CONSUMER.en.md) | Define replacement, withdrawal authority and retention. Check old citations and new queries after each rebuild. |

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
