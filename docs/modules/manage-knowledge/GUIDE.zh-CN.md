# 接入一个可引用的知识源

宿主先为知识服务选择允许阅读的资料范围，并在回环地址 `127.0.0.1` 启动它。示例通过 CoreMind 已有的 Streamable HTTP MCP 接口提供只读工具 `search_knowledge`。查询参数只有 `query`，阅读范围由宿主决定。TypeScript、Python 和 CLI 加载同一项目配置并访问同一服务。

## 从空白项目只接入知识

准备独立的 Python 3.12 环境和 BGE-M3 模型。将[知识单项示例](../../../components/knowledge/README.md)的合成清单、原文目录 `sources/` 和 `query.py` 放在空业务目录，或换成自己的清单与原文。设置完整的 `COREMIND_KNOWLEDGE_AUTHORIZATION`。在业务目录从 PyPI 安装并启动服务，`MODEL_DIR` 指向已校验模型。

```sh
python -m pip install coremind-knowledge-mcp==0.1.1
coremind-knowledge-mcp --version
coremind-knowledge-mcp --manifest ./manifest.json --model-dir "$MODEL_DIR" --state ./state/catalog.json --scope records
```

从源码构建同版本 wheel 的命令见[组件说明](../../../components/knowledge/README.md)。

用支持 Streamable HTTP 的 MCP 客户端连接 `http://127.0.0.1:8767/mcp`，以该变量的完整值发送 `Authorization`。在 `tools/list` 中找到 `search_knowledge` 和 `resolve_citation`，分别查询和回查原文。若宿主是 CoreMind，将[知识服务配置](../../../examples/modules/manage-knowledge/coremind.yaml)中的 `mcp.servers.knowledge` 和所需的 Agent 工具声明加入自己的配置，使用项目自己的模型。此接入无需资料助手模板或其他领域服务。

复制[空白 TypeScript 项目示例](../../../examples/modules/manage-knowledge/README.zh-CN.md#从空白-typescript-项目直接查询)，先在业务代码中搜索和回查，再用同一个服务地址与读令牌运行 CoreMind Agent。直接调用只需知识服务读令牌。运行 Agent 时另行配置业务模型。

## 第一次查询

按[运行示例](../../../examples/modules/manage-knowledge/README.zh-CN.md)准备环境并运行三个入口。用公开身份查询“ST-17 拼接地图现在由哪一个窗口受理？”。在结果中找到“榆木台”，打开[二版索引](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v2.md)核对第 6 行。相同编号在[一版索引](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v1.md)也出现在第 6 行，但窗口为“榛果台”。只核对行号会把旧结果判为正确。

找到了相似条目时，逐项确认摘录支持答案。没有可采信出处时，应告知读者资料不足。替换检索组件时，沿用[开发 SOP](SOP.zh-CN.md)中的问题、权限和版本对照。

Markdown 表格的数据行在 `search_knowledge` 和 `resolve_citation` 中均附带同一文档版本的 `tableHeader`。例如上面的第 6 行保留物件、窗口和包装的原文，`tableHeader[0].line` 为 4，`tableHeader[0].text` 为该表的列名原文。按列名理解每个值，并把引用指向数据行。普通段落、表头自身和代码块中的模拟表格沿用原有引文格式。

0.1.1 为 PDF 和 DOCX 的片段返回正整数 `chunkId`，按文档版本内的片段顺序从 1 编号。页码或节标题 `locator` 用于显示，回查时传入搜索返回的 `docId`、`version`、`file` 和 `chunkId`。定位字段同时传入时须全部匹配。Markdown 继续按行号回查。用[多片段示例](../../../examples/modules/manage-knowledge/README.zh-CN.md#回查同页或同节的片段)可以比较搜索和回查的正文。

## 增量导入与撤回

用 `--state` 指定状态文件，服务会记录每个文档版本的原文、范围和撤回状态。相同版本与内容再次启动时不会重复写入，同版本内容变化会失败并要求提升版本号。撤回使用 `--withdraw DOC:VERSION`，检索立即排除该版本。重建失败时保留上一次索引和状态文件。

历史引文沿用当前知识服务的阅读范围和资料清单的基准日期。有效期包含起始日，不含截止日。范围外或不在有效期内的引文统一返回 `unknown`；在可读范围内才能看到摘录或 `withdrawn` 状态。

0.1.1 仍可仅凭页码或节标题回查唯一匹配的旧引文。一个位置匹配多个片段时返回 `ambiguous`，没有匹配时返回 `missing`。这两种结果均无正文。已撤回的可读版本先返回 `withdrawn`。

升级前保存的 Markdown 状态可用原清单和原文再次导入。服务核对已有正文、行号、版本和权限后补齐表头，保留已撤回标记。后续同版本重导保持幂等。

## 选用持久 Qdrant 索引

使用 0.1.1 时，可在启动命令上追加 `--index-dir ./state/knowledge-index`。同一项目继续使用原来的 `--state`。每个索引目录由一个服务进程独占，应由宿主管理并与状态文件、资料、模型分开。省略该参数时使用内存索引。0.1.0 安装包采用内存索引。

持久索引由已提交目录派生。重启时核对目录与索引，匹配后复用原向量。资料变更时复用未变正文的向量，新索引完整后才提交目录。检索和回查继续核对读者范围、有效期、撤回状态及原来位置。

回退或重建时先停止服务，保留原文、清单和最新目录，再省略 `--index-dir` 或选用新的专用索引目录。使用宿主可信的索引目录，因为 Qdrant 本地模式会反序列化磁盘内容。中断可能留下不活动批次，仍由已提交目录决定查询结果。按[固定集对照](SOP.zh-CN.md#持久索引验收)判断该项目是否值得启用。

## 升级与移除

按[最小部署与恢复示例](../../../examples/modules/manage-knowledge/deployment/README.zh-CN.md)在仓库外演练停机备份与恢复。保留业务清单、原文和目录文件。用这些资料可以重建索引。

更换服务版本前停止旧进程，保存原文、清单、模型版本和状态文件。在副本启动目标版本，复查现行引文、同版本重复导入和已撤回引文，再切换业务连接。回滚时使用原服务环境及已核对的状态，保留升级后产生的撤回记录。业务项目停用知识时，移除该项目的 MCP 工具、服务绑定和读者凭据。若服务专属该项目，再停止进程并卸除专用 Python 环境。业务原文、清单、撤回记录和共用模型由其所有者按保留策略处置。

`chunkId` 从状态文件中该版本已有的片段顺序推导，原状态可直接用于升级和回退。公开的 0.1.0 服务只识别旧定位方式。回退至 0.1.0 后，同页或同节引文应直接核对原件，精确回查需使用支持 `chunkId` 的服务。
