# Run the document assistant with real services

Use two independent document directories and two memory subjects to check citations, preferences, Skill loading, file output, and optional ontology. The scenarios use synthetic documents.

## Setup

1. Create two projects from the [document-assistant template](../../../packages/coremind-templates/templates/general/document-assistant/README.en.md). Use the [archive manifest](document-assistant-corpora/archive/manifest.json) in project A and the [blue manifest](document-assistant-corpora/blue/manifest.json) in B. Give each project a separate knowledge reader credential and catalog state file. Keep each manifest alongside its `sources/` directory.
2. Follow the [knowledge service example](../manage-knowledge/README.en.md) to build the Qdrant indexes with BGE-M3. Follow the [memory service example](../manage-memory/README.en.md) to configure two Hindsight personal banks with distinct reader and administrator credentials. The host confirms or corrects preferences. The agent receives only its subject's read credential.
3. Select a model authorized for the synthetic documents and configure each project's endpoints. In project A, run `node enable-ontology.mjs` and connect the generated configuration to a read-only ontology service using the [document-review model](models/document-review/model.ttl). Restrict summary writes to the project. Keep administrator and action credentials with the host.

## Scenarios

| Step | Host action and new task | Expected result |
| --- | --- | --- |
| A1 | Start with an empty preference bank. Compare the two editions of 资料室手册, cite the changes and save `summary.md`. | The addition 归还后核销 appears in `guide-v2.md` on line 1. The comparison cites `guide-v1.md` on line 1. |
| A2 | Confirm a Markdown table preference. Start a new session with ontology enabled, summarize 新制度草稿 and inspect the `publish` precondition for `urn:doc:draft`. | The summary identifies 档案交接登记 as this week's new rule. It cites revision 1, line 3 of `draft-v1.md`. The column heading is on line 1. The publish check denies the draft because it lacks reviewed status. |
| B1 | Switch to B's project and credentials. Confirm a numbered-list preference and repeat A1's prompt. | A numbered list cites 蓝签复核 and line 1 of `blue-v2.md` and `blue-v1.md`. A's documents and preference remain private. |
| A3 | Correct A's preference to a bulleted list, restart the memory gateway and restart the knowledge service with `--withdraw guide:2`. Repeat A1 in a new session. | The bulleted summary states that only one edition is available and cites `guide-v1.md`. Historical resolution reports the withdrawal. The removed text cannot support a new finding. |

Use `coremind.yaml` for the ordinary assistant and `coremind-ontology.yaml` for the publish check. The template describes the CLI, TypeScript, and synchronous and asynchronous Python commands. From the source root, this command starts a persistent session with a fresh identity in an existing project.

```sh
node examples/modules/manage-ontology/live-document-session.mjs ./project-a/coremind.yaml "按已确认偏好比较《资料室手册》两个版本，附文件名、版本和行号，用 write 保存到 summary.md。"
```

Inspect the returned session ID, run ID and successful tool receipts, then verify the project's `summary.md`. Preserve it before the next case writes the same filename. The project supplies its model, services, and credentials.

## Recovery and isolation

- Each knowledge service must reject the other project's reader. Within a service, historical citation resolution returns `unknown` for inaccessible or expired sources. Memory administration across subjects returns HTTP 403. Verify that recall contains only the authorized bank and active revision.
- Add a source chunk longer than the model limit. Record the state digest after indexing fails. Remove the test source and restart. Accessible revisions and withdrawal receipts must survive.
- Stop the knowledge service and run the document task again. Check model request count and the output file. Cancel a call while awaiting the model and check the run outcome and output file. For external actions, verify the business database's write count and the receipt returned to the agent. [Action checks](README.en.md)

## Windows development checks on 2026-11-24

The host ran Windows 11 on an Intel Core Ultra 9 285H with 31.5 GiB of RAM. Knowledge retrieval used Qdrant Client 1.15.1 in memory and BGE-M3 ONNX INT8. Memory used Hindsight 1.2.3 with PostgreSQL 18.1. RDFLib 7.6.0 and pySHACL 0.40.2 checked the draft. Qwen3.8-27B performed inference on the synthetic tasks. Each project started its knowledge service in turn with its own sources, state, and reader credential. Hindsight hosted both personal banks concurrently.

| Measurement | Observed on this host |
| --- | --- |
| Initial readiness | Knowledge 7.59 s, memory gateway 3.79 s, ontology 3.82 s. Hindsight was observed ready 23.36 s after launch. |
| Query | Ten repetitions of the same authenticated knowledge MCP query. Median 33.86 ms, nearest-rank P95 69.12 ms. |
| Index | Separate build with five Markdown documents and six chunks. Model loading took 2.59 s. Building the empty index, encoding and inserting all chunks took 0.15 s. |
| Working set | Sampled each service process tree every 250 ms. Hindsight peaked at 1247.3 MiB, knowledge at 1098.4 MiB, the memory gateway at 111.3 MiB, and ontology at 77.8 MiB. These are independent service peaks. |

The CLI, TypeScript, synchronous Python, and asynchronous Python produced the saved summaries for A1, A2, B1, and A3 respectively. Three separate ChatSessions checked the empty, confirmed-table, and corrected-list preferences. In the final table retest, TypeScript and ChatSession took 45.73 s and 41.70 s. Each made four model requests and wrote the same weekly rule, line 3 citation, and reason for denying publication. [Individual runs, actual summaries, session receipts, and full hashes](live-composition-results.json)

Earlier runs exposed contention between serial tool calls, Qwen reasoning exhausting the 900-token limit, repeat searches exhausting the 15-tool limit, and a data row being described as a title. The retest used the original task and budgets. Both search and citation resolution returned line 3 together with its line 1 header. The initial grader misread “row 3 (see heading on row 1)” as “row 3 is the heading”. We rechecked the same output bytes and both incorrect prior summaries. Both corrected summaries passed. The evidence records separate byte hashes for the original LF project files (1034 bytes) and the CRLF archives on Windows (1057 bytes).

Swapping knowledge credentials between the projects returned 401 in both directions. Cross-subject memory administration returned 403. The corrected preference survived a gateway restart. An invalid incremental document failed a real index build and preserved the catalog state digest. Stopping the knowledge service caused the next run to fail before any model request. Cancellation after upstream response headers produced an `aborted` result, zero write calls, and a byte-identical output file. A synthetic SQLite action handler committed a transaction and dropped its acknowledgment. The first request reported `unknown`. Replaying it or providing a new request ID left exactly one database row.

For unattended CLI verification the host preapproved writes in the temporary project. SDK approval was restricted to the project's `summary.md`. Python used the Node Worker built in the workspace. Candidate and public package checks belong to the release stage. The measurements cover small synthetic documents. Independent PostgreSQL, the model server, and the host SDK are outside the service memory measurements.
