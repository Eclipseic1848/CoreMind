# Knowledge retrieval development SOP

1. Assign each original a document ID, version, validity interval and read scope. Choose a concrete question and mark its supporting passage. Add questions supported only by expired material, by another reader's material or by none of the sources.
2. Pin the parser, retrieval component, model and input versions. Index source files and their metadata. Keep the questions, answer key, gold citations and three-round scenario on the scoring side.
3. Send the same question, date and read scope through the configuration, TypeScript and Python entry points. Compare the document, version, location and excerpt in every result. For a Chinese table, check that each value is tied to the correct row and column.
4. Run the 30 answerable questions in the [fixed dataset](../../../examples/knowledge-evals/zh-retrieval/README.zh-CN.md). Record top-one and top-five hits, missed question IDs and elapsed time. Compare with SQLite FTS5 on identical inputs. The P1 target is at least 27 of 30 top-five hits.
5. Check the ten unanswerable questions for expired or unauthorized results. If the application generates answers, check those answers for fabricated citations separately. Similar passages can match an unanswerable question.
6. Run the tests in the [module manifest](module.yaml) and `npm run check:modules`. Record the test environment, corpus digest, component versions, citations from all three entry points and the reasons for choosing a retrieval method.
7. Check increments and withdrawal: start twice with `--state` and confirm no change; change content under the same version and confirm rejection; withdraw an active version and confirm search excludes it and old citations report `withdrawn`; inject a rebuild failure and confirm the previous index and state file remain.
8. Resolve the same citation as two readers. Check the first valid day, expiry day and withdrawal. Inject a state-file replacement failure and verify search, citation lookup and restart all reflect the last committed version.
9. Install from the current source and run the [excerpt lookup example](../../../examples/modules/manage-knowledge/README.en.md#resolve-excerpts-on-the-same-page-or-in-the-same-section). Search for multiple fragments from the same PDF page and DOCX section. Resolve each hit with its `docId`, `version`, `file` and `chunkId`, then compare the returned text exactly and repeat after restart. Send the shared `locator` without `chunkId` and expect `ambiguous` with no excerpt. A unique legacy location must still resolve. Verify `withdrawn` with the authorized reader and `unknown` for an out-of-scope or expired citation.

## Standalone wheel acceptance

Follow the [empty TypeScript project example](../../../examples/modules/manage-knowledge/README.en.md#query-directly-from-an-empty-typescript-project) outside the checkout.

| Check | Expected result |
| --- | --- |
| Direct search and lookup | Use a standard MCP client to call `search_knowledge` and pass the citation identity to `resolve_citation`. Compare document ID, version, file, location and exact text. Use Markdown line numbers on the published 0.1.0 as the baseline. Test the PDF and DOCX `chunkId` against a build containing the fix. |
| Agent binding | Run the installed CoreMind TypeScript SDK with the same endpoint, reader token and question. Verify the search and lookup tool calls, then compare the original excerpt and source. |
| Access, outage and removal | Verify HTTP 401 with an invalid token. Switch to another read scope and check that search excludes restricted material and lookup returns `unknown`. Stop the dedicated service and verify the call fails. Remove the tool binding, run the Agent and record zero knowledge tool calls. |

1. In an empty directory outside the checkout and a fresh Python 3.12 environment, install only the chosen version of the knowledge component. For 0.1.0, run `python -m pip install coremind-knowledge-mcp==0.1.0`. Record its source, version, artifact digest and launch command. Move the checkout out of reach and start with the business manifest, originals and pinned model. Use a standard MCP client to check missing-credential rejection, authorized search and citation resolution, then check the application's own entry point.
2. For the first packaged release, generate real state containing a withdrawn edition with the 2.0.0 source service. Compare behavior before and after upgrade and rollback using the guide. For later upgrades, use the previous released distribution as the baseline.
3. Remove the project binding and dedicated service environment. Verify that other project features still run and that the originals, state file and withdrawal records remain available. Record the independent install result separately from source-level regressions.

Run the [migration regression](../../../components/knowledge/tests/installed_lifecycle.py) outside the checkout with the installed wheel's interpreter. Supply `--console`, `--model-dir`, `--example`, and `--legacy-archive` (the official 2.0.0 source ZIP). It generates a real prior catalog, moves the prior service aside, exercises a standard MCP client, two reader scopes, replacement and withdrawal, then restarts the previous service against the last committed state after an induced rebuild failure.

The local 0.1.0 acceptance run used Windows, Python 3.12.13 and wheel SHA-256 `de84e44f6d68dde7e85d63f21551ffe5add7b4d8bfbbbac98f90fb4f68f494ef`. Tests used synthetic documents and local model weights.

| Check | Observed result |
| --- | --- |
| Empty business project | Installed only the knowledge wheel and its dependencies. A standard MCP client resolved line 3 with its header at line 1. Missing credentials returned 401. Another reader had no matches and received `unknown` on lookup. |
| Migration and rollback | The official 2.0.0 source service generated the prior catalog. The wheel preserved its citations and withdrawal. Neither an unknown withdrawal nor an oversized chunk changed the last committed state. The previous service then resolved the new edition and both withdrawals. |
| Component removal | Uninstalling the working wheel from a second dedicated environment removed its console and Python package. The manifest, original, sample client and catalog with a withdrawal retained all four digests. The business-side reader still read the original table row. |
| Retrieval and parsing | Sparse retrieval placed the gold passage first on 30/30 answerable questions. All ten unanswerable questions still returned candidates. With an existing Docling/RapidOCR environment, the wheel parsed four PDF and three DOCX chunks, including the scanned-page and table locations. |

## Held-out knowledge regression

From the checkout, run `python -B -X utf8 examples/knowledge-evals/zh-retrieval/answer_benchmark.py --replay --output knowledge.json`. The held-out questions use the same synthetic corpus, and indexing reads source files without answer labels. Check top-five retrieval, exact short answers and citations for seven positive cases, and explicit refusals for six negative cases. Record top-one hits, similar candidates, incorrect answers and verifier rejections independently. A failed check still writes the per-case report. [Replay and report details](../../../examples/knowledge-evals/zh-retrieval/README.zh-CN.md#独立题集离线回放)

## Deployment and recovery acceptance

Follow the [minimal deployment and recovery example](../../../examples/modules/manage-knowledge/deployment/README.en.md). With pinned model files and a pinned wheel, compare active citations and withdrawals before and after restarting. Then stop the service, back up originals, manifest and catalog, and validate a restore at a different path. Record startup and restore time plus backup and model size. Record upgrade and rollback separately using the [installed lifecycle test](../../../components/knowledge/tests/installed_lifecycle.py).

## Automated acceptance for direct knowledge and memory calls

Prepare both example projects and their installed dependencies outside the checkout. Have the host start the actual knowledge service and Hindsight gateway. For each capability, prepare one authorized reader whose query matches the expected excerpt and another authorized reader whose query returns no hits. Save the following JSON in a private file outside the checkout. Replace the endpoints, full reader tokens and expected text. The knowledge example uses two read scopes. The memory example uses two banks on one gateway.

```json
{
  "knowledge": {
    "url": "http://127.0.0.1:8767/mcp",
    "authorization": "Bearer <knowledge reader token>",
    "query": "松纹卡",
    "expected": "银杏台",
    "other": { "url": "http://127.0.0.1:8768/mcp", "authorization": "Bearer <other knowledge reader token>" }
  },
  "memory": {
    "url": "http://127.0.0.1:8769/mcp",
    "authorization": "Bearer <memory reader token>",
    "query": "Which format should I use for document summaries?",
    "expected": "Prefer tables for document summaries.",
    "other": { "url": "http://127.0.0.1:8769/mcp", "authorization": "Bearer <other memory reader token>" }
  }
}
```

Run the [acceptance script](../../../scripts/verify-direct-consumers.mjs) from the checkout root. Pass the interpreter path from the application project's virtual environment as the third argument.

```sh
node scripts/verify-direct-consumers.mjs "<external-ts-project>" "<external-python-project>" "<python-interpreter>" "<private-json>"
```

The script starts a deterministic model and an HTTP 503 fixture on loopback. It checks each component for direct calls, empty results for the other reader, missing and invalid credentials, unavailability, binding the same service to an Agent, and a Runtime-only run after removal. The output lists the cases and count. Evaluate live model quality separately.
