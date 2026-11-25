# Retrieve Chinese documents through three entry points

The knowledge service can run on its own from the 2.0.0 source release. The Node build below is for maintainers testing the CoreMind client entry points. For a business project using only knowledge, follow the [empty-project guide](../../../docs/modules/manage-knowledge/GUIDE.en.md). A document-assistant template is optional. The [0.1.0 knowledge component](../../../components/knowledge/README.md) provides a local standalone wheel and a standard MCP client example.

This example uses the [synthetic Songyu records-room corpus](../../knowledge-evals/zh-retrieval/manifest.json). The knowledge service runs locally with a host-selected reader scope. The model sends only the query text in its tool call. Index the five source files with their manifest metadata. Keep the questions and gold answers on the scoring side.

## Prerequisites

Use the Node.js and npm versions required by this checkout and an active Python 3.12 virtual environment. Build from the repository root. Use the same directory and virtual environment in both terminals.

```sh
npm ci
npm run build
python -m pip install -r examples/modules/manage-knowledge/requirements.txt -r examples/knowledge-evals/zh-retrieval/requirements-retrieval.txt
```

## Prepare the retrieval model and run the fixed dataset

Run these commands from the repository root in an active Python 3.12 environment. The first weight download uses the Hugging Face CLI and requires network access. Alternatively, provision the same files locally. Quantized BGE-M3 runs on the CPU with a local Qdrant index.

```sh
hf download gpahal/bge-m3-onnx-int8 model_quantized.onnx tokenizer.json --revision 2b34e84df040034d4b9eabb62383a87c18955822 --local-dir .scratch/p1/qdrant-model
python -X utf8 examples/knowledge-evals/zh-retrieval/qdrant_benchmark.py --model-dir .scratch/p1/qdrant-model --output .scratch/p1/qdrant-results.json
```

The table reports hits on the 30 answerable synthetic questions. This example uses learned sparse retrieval because it ranked the correct evidence first on every answerable question in this corpus and needs a single ranking. All four methods also returned candidates for the ten unanswerable questions. Score the application's decision to abstain separately. [Keyword baseline](../../knowledge-evals/zh-retrieval/README.zh-CN.md)

| Retrieval method | Top-one hits | Top-five hits |
| --- | ---: | ---: |
| SQLite FTS5 BM25 | 27/30 | 30/30 |
| BGE-M3 dense | 29/30 | 30/30 |
| BGE-M3 learned sparse | 30/30 | 30/30 |
| Dense and sparse with RRF | 29/30 | 30/30 |

## Evaluate generated answers separately

With `qwen3:1.7b` running in local Ollama, pass the same top-five sparse retrieval results to the model. The script checks the installed model digest before running. Its report identifies the model and question set.

```sh
python -B -X utf8 examples/knowledge-evals/zh-retrieval/answer_benchmark.py --model-dir .scratch/p1/qdrant-model --output .scratch/p1/qwen3-answer-results.json
```

In one local run with Ollama 0.12.11, 25 of 30 answerable questions matched both the strict short answer and citation. The citation matched on 29 of 30. On unanswerable questions, 6 of 10 responses returned the required empty answer and empty citation list. N03, N06, N07 and N08 failed this check. N06 returned the literal text “空字符串” (“empty string”) with no citation. Applications requiring reliable abstention need further validation of answer generation.

## Start the service and verify the three entry points

Supply the same `COREMIND_KNOWLEDGE_AUTHORIZATION` environment variable to both terminals. Its value is `Bearer ` (including the trailing space) followed by a random token dedicated to this service, at least 24 characters long.

Start the service in the first terminal and leave it running. It imports the sources into an in-memory index on startup. The default manifest contains synthetic documents. The default read scope is `public`. Supply `--manifest` or `--scope` at service startup to change the corpus or reader scope.

```sh
python -B -X utf8 examples/modules/manage-knowledge/knowledge_server.py --model-dir .scratch/p1/qdrant-model
```

Once ready, run the acceptance script in the second terminal. It uses `python` from PATH unless `COREMIND_KNOWLEDGE_PYTHON` points to the interpreter in your virtual environment. Press Ctrl+C in the service terminal when finished.

```sh
node examples/modules/manage-knowledge/acceptance.mjs
```

The acceptance script runs the CLI with the project configuration, the TypeScript SDK and the Python SDK (sync and async). Each makes a real call to the same MCP service. See the [configuration](coremind.yaml), [TypeScript entry point](search.mjs) and [Python entry point](search.py) for the bindings.

## Incremental imports and withdrawal

Pass `--state` to keep each version's text, scope and withdrawal status. Restarting with the same version and content does not duplicate it; changed content fails until the version is bumped. `--withdraw DOC:VERSION` withdraws a version at startup, and `resolve_citation` reports whether an old citation is `available`, `withdrawn` or `unknown`.

```sh
python -B -X utf8 examples/modules/manage-knowledge/knowledge_server.py --model-dir .scratch/p1/qdrant-model --state .scratch/p1/knowledge-state.json
python -B -X utf8 examples/modules/manage-knowledge/knowledge_server.py --model-dir .scratch/p1/qdrant-model --state .scratch/p1/knowledge-state.json --withdraw 资料室手册:2
cd examples/modules/manage-knowledge && python -B -X utf8 -m unittest test_knowledge_catalog.py -v
```

The unit tests cover idempotent imports, same-version conflicts, withdrawal in search and citation resolution, rebuild rollback and state reload.

## Check document parsing

Use a Python 3.12 environment from the repository root. PDF conversion needs the layout, table and Chinese OCR models available on the first run. The parser fixtures include a mixed native-text/scanned PDF, a DOCX table and a Markdown file.

```sh
python -m pip install "docling[rapidocr]==2.151.1"
python -X utf8 examples/knowledge-evals/zh-retrieval/docling_bridge.py examples/knowledge-evals/zh-retrieval/formats/值班记录.pdf
python -X utf8 examples/knowledge-evals/zh-retrieval/docling_bridge.py examples/knowledge-evals/zh-retrieval/formats/归档窗口.docx
```

Each fragment contains `text` and a `locator`. The following checks cover the native Chinese text and scanned page of the PDF, the headers and rows of the DOCX table, and the Markdown section location. The default five-document retrieval corpus indexes Markdown lines directly. PDF and DOCX imports use Docling page or section locations.

```sh
python -B -X utf8 examples/knowledge-evals/zh-retrieval/test_docling_bridge.py -v
```

For offline operation, prefetch assets with `docling-tools models download layout tableformer rapidocr --rapidocr-backend-lang onnxruntime:ch -o MODEL_DIR`, point `DOCLING_ARTIFACTS_PATH` at that directory and set `HF_HUB_OFFLINE` to `1`. [Docling offline setup](https://docling-project.github.io/docling/usage/advanced_options/)

## Check the returned evidence

The acceptance script asks “现行的普通咨询要从哪个栏目递交？” (Where should a reader submit a general inquiry under the current rules?). All four public-scope calls should include the same source passage.

| Check | Expected value |
| --- | --- |
| Document and edition | 资料室手册, edition 2 |
| Source location | Line 5 of `资料室手册-v2.md` |
| Supporting excerpt | 普通咨询从资料室的“读者来信”栏提交。 |

Check the excerpt in the [second edition](../../knowledge-evals/zh-retrieval/sources/资料室手册-v2.md). Retrieval uses a real embedding model and Qdrant. Each entry point uses a local model fixture to request the tool call and return its JSON for comparison.

[Integration guide](../../../docs/modules/manage-knowledge/GUIDE.en.md) · [Evaluation procedure](../../../docs/modules/manage-knowledge/SOP.en.md) · [Clean consumer verification](../../../docs/modules/manage-knowledge/CLEAN-CONSUMER.en.md)
