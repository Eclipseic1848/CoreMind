# 通过三个入口检索中文资料

本例包含两种操作：源码中的知识服务可以单独启动；下方的 Node 构建用于维护者复验 CoreMind 客户端入口。业务项目只需要知识时，直接按[空白项目接入指南](../../../docs/modules/manage-knowledge/GUIDE.zh-CN.md)连接服务，无需创建资料助手模板。[知识组件 0.1.0](../../../components/knowledge/README.md)是 2.1.0 候选的独立本地 wheel，配有普通 MCP 客户端示例。

本例使用[松屿资料室合成资料](../../knowledge-evals/zh-retrieval/manifest.json)。示例知识服务在本机运行，宿主选定读者范围。模型调用工具时仅提交查询文本。索引只接收五份来源文件和清单元数据。题目与答案位于评分端。

## 启动前准备

使用源码仓库要求的 Node.js、npm 和已激活的 Python 3.12 虚拟环境，从仓库根目录构建。两个终端使用同一目录和虚拟环境。

```sh
npm ci
npm run build
python -m pip install -r examples/modules/manage-knowledge/requirements.txt -r examples/knowledge-evals/zh-retrieval/requirements-retrieval.txt
```

## 准备检索模型并复跑固定集

从仓库根目录在已激活的 Python 3.12 环境运行。首次取权重使用 Hugging Face CLI，需要网络或由宿主提前准备相同的文件。本地模式由 CPU 运行量化 BGE-M3；Qdrant 索引在同机运行。

```sh
hf download gpahal/bge-m3-onnx-int8 model_quantized.onnx tokenizer.json --revision 2b34e84df040034d4b9eabb62383a87c18955822 --local-dir .scratch/p1/qdrant-model
python -X utf8 examples/knowledge-evals/zh-retrieval/qdrant_benchmark.py --model-dir .scratch/p1/qdrant-model --output .scratch/p1/qdrant-results.json
```

在同一组合成资料中，30 道有依据的问题获得以下命中数。示例选择学习式稀疏向量检索，它在这组问题上首条全部命中，且只需一次排序。10 道无答案题在四种方法下都返回了候选片段。检索命中与回答能否正确拒答应分别计分。[关键词基线](../../knowledge-evals/zh-retrieval/README.zh-CN.md)

| 检索方法 | 首条命中 | 前五条命中 |
| --- | ---: | ---: |
| SQLite FTS5 BM25 | 27/30 | 30/30 |
| BGE-M3 稠密向量 | 29/30 | 30/30 |
| BGE-M3 学习式稀疏向量 | 30/30 | 30/30 |
| 稠密、稀疏结果用 RRF 融合 | 29/30 | 30/30 |

## 单独评估生成回答

本机 Ollama 运行 `qwen3:1.7b` 时，可将相同的前五条稀疏检索结果交给模型。脚本在运行前核对已安装模型的摘要，报告记录模型和题集版本。

```sh
python -B -X utf8 examples/knowledge-evals/zh-retrieval/answer_benchmark.py --model-dir .scratch/p1/qdrant-model --output .scratch/p1/qwen3-answer-results.json
```

在 Ollama 0.12.11 的一次本地运行中，严格短答与出处同时命中 25/30，出处命中 29/30。无答案题按约定返回空答案、空引文的有 6/10。N03、N06、N07、N08 未满足该条件，其中 N06 输出了“空字符串”三个字且没有引文。应用若要求缺依据时可靠拒答，需要继续验证生成环节。

## 启动服务并验证三个入口

向两个终端注入相同的环境变量 `COREMIND_KNOWLEDGE_AUTHORIZATION`。值由 `Bearer `（含尾部空格）和本次服务专用的随机令牌组成，令牌至少 24 个字符。

在第一个终端启动服务并保持运行。服务启动时将来源导入内存索引。默认清单使用合成资料，阅读范围为 `public`。在宿主启动服务时可用 `--manifest` 或 `--scope` 更改资料集或身份。

```sh
python -B -X utf8 examples/modules/manage-knowledge/knowledge_server.py --model-dir .scratch/p1/qdrant-model
```

服务就绪后，在第二个终端执行验收，使用 PATH 中的 `python` 或由 `COREMIND_KNOWLEDGE_PYTHON` 指定的虚拟环境解释器。完成后，在服务终端按 Ctrl+C 退出。

```sh
node examples/modules/manage-knowledge/acceptance.mjs
```

验收从项目配置启动 CLI、TypeScript SDK 和 Python SDK（同步与异步），各入口实际调用同一 MCP 服务。绑定方式见[项目配置](coremind.yaml)、[TypeScript 入口](search.mjs)及[Python 入口](search.py)。

## 增量导入与撤回

使用 `--state` 保存每个文档版本的原文、范围和撤回状态。相同版本与内容重复启动不会重复写入；同版本内容变化会失败并要求提升版本号。`--withdraw DOC:VERSION` 在启动时撤回指定版本；服务提供的 `resolve_citation` 返回旧引文是 `available`、`withdrawn` 还是 `unknown`。

```sh
python -B -X utf8 examples/modules/manage-knowledge/knowledge_server.py --model-dir .scratch/p1/qdrant-model --state .scratch/p1/knowledge-state.json
python -B -X utf8 examples/modules/manage-knowledge/knowledge_server.py --model-dir .scratch/p1/qdrant-model --state .scratch/p1/knowledge-state.json --withdraw 资料室手册:2
cd examples/modules/manage-knowledge && python -B -X utf8 -m unittest test_knowledge_catalog.py -v
```

单元测试覆盖幂等导入、同版本冲突、撤回后检索与引文、重建失败回滚和状态重启。

## 复核文档解析

在仓库根目录使用 Python 3.12 环境准备 Docling。首次解析 PDF 需要布局、表格与中文 OCR 模型可用。测试资料包含一份原生文本与扫描页混排的 PDF、一份含表格的 DOCX 和一份 Markdown。

```sh
python -m pip install "docling[rapidocr]==2.151.1"
python -X utf8 examples/knowledge-evals/zh-retrieval/docling_bridge.py examples/knowledge-evals/zh-retrieval/formats/值班记录.pdf
python -X utf8 examples/knowledge-evals/zh-retrieval/docling_bridge.py examples/knowledge-evals/zh-retrieval/formats/归档窗口.docx
```

输出的每个片段包含 `text` 和 `locator`。以下命令复核 PDF 的中文原生文本及扫描页、DOCX 的表头和数据行，以及 Markdown 的章节位置。默认五文档检索集直接按 Markdown 行号建索引。PDF、DOCX 导入使用 Docling 的页码或章节定位。

```sh
python -B -X utf8 examples/knowledge-evals/zh-retrieval/test_docling_bridge.py -v
```

离线使用时，可先用 `docling-tools models download layout tableformer rapidocr --rapidocr-backend-lang onnxruntime:ch -o MODEL_DIR` 预取资源，然后把 `DOCLING_ARTIFACTS_PATH` 设置为该目录，`HF_HUB_OFFLINE` 设为 `1`。[Docling 离线运行说明](https://docling-project.github.io/docling/usage/advanced_options/)

## 核对返回的证据

验收脚本固定查询“现行的普通咨询要从哪个栏目递交？”。以公开身份运行时，四次调用均应在结果中包含同一版本的原文。

| 核对项 | 期望 |
| --- | --- |
| 来源及版本 | 资料室手册，二版 |
| 原文位置 | `资料室手册-v2.md` 第 5 行 |
| 可采信的摘录 | 普通咨询从资料室的“读者来信”栏提交。 |

用[二版手册](../../knowledge-evals/zh-retrieval/sources/资料室手册-v2.md)复核结果。检索运行真实嵌入模型和 Qdrant。入口验收使用本地模型夹具发起工具调用、转发检索 JSON 并逐项比对。

[接入指南](../../../docs/modules/manage-knowledge/GUIDE.zh-CN.md) · [效果评测步骤](../../../docs/modules/manage-knowledge/SOP.zh-CN.md) · [干净消费者验收](../../../docs/modules/manage-knowledge/CLEAN-CONSUMER.zh-CN.md)
