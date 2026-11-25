# 接入一个可引用的知识源

宿主先为知识服务选择允许阅读的资料范围，并在回环地址 `127.0.0.1` 启动它。示例通过 CoreMind 已有的 Streamable HTTP MCP 接口提供只读工具 `search_knowledge`。查询参数只有 `query`，阅读范围由宿主决定。TypeScript、Python 和 CLI 加载同一项目配置并访问同一服务。

## 第一次查询

按[运行示例](../../../examples/modules/manage-knowledge/README.zh-CN.md)准备环境并运行三个入口。用公开身份查询“ST-17 拼接地图现在由哪一个窗口受理？”。在结果中找到“榆木台”，打开[二版索引](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v2.md)核对第 6 行。相同编号在[一版索引](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v1.md)也出现在第 6 行，但窗口为“榛果台”。只核对行号会把旧结果判为正确。

找到了相似条目时，逐项确认摘录支持答案。没有可采信出处时，应告知读者资料不足。替换检索组件时，沿用[开发 SOP](SOP.zh-CN.md)中的问题、权限和版本对照。

Markdown 表格的数据行在 `search_knowledge` 和 `resolve_citation` 中均附带同一文档版本的 `tableHeader`。例如上面的第 6 行保留物件、窗口和包装的原文，`tableHeader[0].line` 为 4，`tableHeader[0].text` 为该表的列名原文。按列名理解每个值，并把引用指向数据行。普通段落、表头自身和代码块中的模拟表格沿用原有引文格式。

## 增量导入与撤回

用 `--state` 指定状态文件，服务会记录每个文档版本的原文、范围和撤回状态。相同版本与内容再次启动时不会重复写入；同版本内容变化会失败，要求提升版本号。撤回使用 `--withdraw DOC:VERSION`，检索立即排除该版本，旧运行可通过 `resolve_citation` 查询原引文是可用、已撤回还是未知。重建失败时保留上一次索引和状态文件。

历史引文沿用当前知识服务的阅读范围和资料清单的基准日期。有效期包含起始日，不含截止日。范围外或不在有效期内的引文统一返回 `unknown`；在可读范围内才能看到摘录或 `withdrawn` 状态。

升级前保存的 Markdown 状态可用原清单和原文再次导入。服务核对已有正文、行号、版本和权限后补齐表头，保留已撤回标记。后续同版本重导保持幂等。
