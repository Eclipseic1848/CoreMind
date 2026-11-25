# CoreMind Knowledge MCP

`coremind-knowledge-mcp` 0.1.0 是可独立安装的本地 wheel，面向任何支持 Streamable HTTP 的 MCP 客户端。服务使用固定的 BGE-M3 ONNX 模型与内存 Qdrant 检索，目录和撤回记录持久化在业务方指定的状态文件。此版本的交付方式是本地 wheel，尚未发布到 PyPI。

## 安装与首次查询

维护者在组件目录运行 `python -m pip wheel --no-deps . -w dist`，将 wheel 和 [example](example/manifest.json) 中的清单、`sources/` 与 `query.py` 交给业务方。业务方只需自己的 Python 3.12 虚拟环境、这份 wheel 以及两个已校验的模型文件。模型目录应包含 `model_quantized.onnx` 和 `tokenizer.json`，来源为 `gpahal/bge-m3-onnx-int8` 的 `2b34e84df040034d4b9eabb62383a87c18955822` 修订。服务启动时校验两者的 SHA-256。

将示例文件放入空业务目录，激活专用 Python 环境并在该目录执行以下命令。令牌由服务所有者生成，两个终端的 `COREMIND_KNOWLEDGE_AUTHORIZATION` 都应为同一完整的 `Bearer <随机令牌>`，令牌至少 24 个字符。将 `/path/to/model` 换为本地模型目录。

```sh
python -m pip install ./coremind_knowledge_mcp-0.1.0-py3-none-any.whl
coremind-knowledge-mcp --version
coremind-knowledge-mcp --manifest ./manifest.json --model-dir /path/to/model --scope records --state ./state/catalog.json
```

在另一个终端运行 `python -X utf8 query.py 松纹卡`。示例回查 `desk.md` 第 3 行的“松纹卡 | 银杏台”，并携带第 1 行表头。服务监听 `127.0.0.1:8767/mcp`，`--port` 可改端口，客户端可用 `KNOWLEDGE_MCP_URL` 指定地址。按 Ctrl+C 停止服务。每个读者范围使用专用服务进程和凭据。

Markdown 使用基础安装。PDF/DOCX 需要用同一 wheel 安装可选扩展，例如 `python -m pip install "./coremind_knowledge_mcp-0.1.0-py3-none-any.whl[documents]"`。扫描 PDF 使用 Docling 与 RapidOCR 的本地模型，离线部署前需预置解析模型。

## 版本与状态

来源内容变化时提升清单中的文档版本。用有效期切换现行版本，或在下次启动附加 `--withdraw desk:1`。历史回查只向获准读者返回当前可见的原文或撤回标记。来源、清单、模型和状态文件分别管理，每份可写状态只由一个进程负责。更新或卸载组件前停止服务并保留状态和原文。升级先用状态副本核对当前和已撤回引文，失败时用原环境和备份恢复。卸载命令是 `python -m pip uninstall coremind-knowledge-mcp`。

## English quick start

Version 0.1.0 ships as a local wheel. In a dedicated Python 3.12 environment, run the installation and launch commands above with your project manifest, BGE-M3 model directory, reader scope, and writable catalog path. Use the same `Authorization` header in your client and server environment. Run `python -X utf8 query.py` from the example directory to search and resolve an original citation. Markdown works with the base wheel. Install the `documents` extra for Docling/RapidOCR PDF or DOCX support and provision parser assets for offline use. Stop the server with Ctrl+C. Before changing versions, back up the project manifest, originals and catalog with withdrawal history, then test the replacement on a copy. Uninstall the component from its dedicated environment after removing the client binding.
