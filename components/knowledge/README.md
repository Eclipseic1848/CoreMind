# CoreMind Knowledge MCP

`coremind-knowledge-mcp` 0.1.1 可独立安装，面向任何支持 Streamable HTTP 的 MCP 客户端。服务使用固定的 BGE-M3 ONNX 模型与内存 Qdrant 检索，目录和撤回记录持久化在业务方指定的状态文件。

## 安装与首次查询

在专用 Python 3.12 环境中从 PyPI 安装组件，下载[示例目录](https://github.com/Eclipseic1848/CoreMind/tree/main/components/knowledge/example)中的清单、`sources/` 与 `query.py`。模型目录应包含 `model_quantized.onnx` 和 `tokenizer.json`，来源为 `gpahal/bge-m3-onnx-int8` 的 `2b34e84df040034d4b9eabb62383a87c18955822` 修订。服务启动时校验两者的 SHA-256。

将示例文件放入空业务目录，激活专用 Python 环境并在该目录执行以下命令。令牌由服务所有者生成，两个终端的 `COREMIND_KNOWLEDGE_AUTHORIZATION` 都应为同一完整的 `Bearer <随机令牌>`，令牌至少 24 个字符。将 `/path/to/model` 换为本地模型目录。

```sh
python -m pip install coremind-knowledge-mcp==0.1.1
coremind-knowledge-mcp --version
coremind-knowledge-mcp --manifest ./manifest.json --model-dir /path/to/model --scope records --state ./state/catalog.json
```

在另一个终端运行 `python -X utf8 query.py 松纹卡`。示例回查 `desk.md` 第 3 行的“松纹卡 | 银杏台”，并携带第 1 行表头。服务监听 `127.0.0.1:8767/mcp`，`--port` 可改端口，客户端可用 `KNOWLEDGE_MCP_URL` 指定地址。按 Ctrl+C 停止服务。每个读者范围使用专用服务进程和凭据。

Markdown 使用基础安装。PDF/DOCX 使用可选扩展 `python -m pip install "coremind-knowledge-mcp[documents]==0.1.1"`。扫描 PDF 使用 Docling 与 RapidOCR 的本地模型，离线部署前需预置解析模型。

从源码交付时，在组件目录运行 `python -m pip wheel --no-deps . -w dist`。在服务环境中用 `python -m pip install /path/to/coremind_knowledge_mcp-0.1.1-py3-none-any.whl` 安装该文件。

当前源码可用 `--index-dir ./state/index` 启用独占的持久 Qdrant 目录，和现有 `--state` 一起使用。保留原文、清单和目录文件，通过回查核对后再切换业务连接。省略该参数会按目录重建内存索引。

当前源码的 PDF 和 DOCX 引文带有文档版本内的 `chunkId`。将同一次搜索得到的文档 ID、版本、文件名和 `chunkId` 一并交给回查工具。可用[合成文档及运行步骤](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-knowledge/README.zh-CN.md#回查同页或同节的片段)核对原文。

## 版本与状态

新导入文档的 ID 长度为 1 至 200 个字符，首尾不能含空白。历史目录中已有的原始 ID 保留，调用回查或撤回时使用搜索返回的原始 ID。查询明确包含文档编号时，服务优先从读者可见且在查询日期有效的该文档中选取相关片段。可用引号指明含空格或非 ASCII 的编号。

来源内容变化时提升清单中的文档版本。用有效期切换现行版本，或在下次启动附加 `--withdraw desk:1`。历史回查只向获准读者返回当前可见的原文或撤回标记。来源、清单、模型和状态文件分别管理，每份可写状态只由一个进程负责。更新或卸载组件前停止服务并保留状态和原文。升级先用状态副本核对当前和已撤回引文，失败时用原环境和备份恢复。卸载命令是 `python -m pip uninstall coremind-knowledge-mcp`。

## English quick start

New IDs must contain 1 to 200 characters without leading or trailing whitespace. Existing IDs remain addressable exactly as returned by search. Explicit document IDs prioritize relevant excerpts from matching, visible, effective documents. Quote non-ASCII IDs or IDs with spaces in search queries.

Source builds support an optional dedicated local Qdrant directory via `--index-dir ./state/index` alongside the existing `--state`. Keep the manifest, originals, and catalog, then verify citations before switching the business connection. Omit the option to rebuild the in-memory index from the catalog.

Install version 0.1.1 from PyPI in a dedicated Python 3.12 environment, or build and install the wheel as shown above for a source deployment. Start the service with your project manifest, BGE-M3 model directory, reader scope, and writable catalog path. Use the same `Authorization` header in your client and server environment. Run `python -X utf8 query.py` from the example directory to search and resolve an original citation. Markdown works with the base wheel. Install the `documents` extra for Docling/RapidOCR PDF or DOCX support and provision parser assets for offline use. Stop the server with Ctrl+C. Before changing versions, back up the project manifest, originals and catalog with withdrawal history, then test the replacement on a copy. Uninstall the component from its dedicated environment after removing the client binding.

Source builds include a document-version-scoped `chunkId` for exact PDF and DOCX citation lookup. Pass the ID with the document ID, version and filename from the search result. Follow the [excerpt lookup example](https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-knowledge/README.en.md#resolve-excerpts-on-the-same-page-or-in-the-same-section) to try it.
