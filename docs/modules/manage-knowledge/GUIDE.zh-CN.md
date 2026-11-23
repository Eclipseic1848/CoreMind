# 接入一个可引用的知识源

宿主先为知识服务选择允许阅读的资料范围，并在回环地址 `127.0.0.1` 启动它。示例通过 CoreMind 已有的 Streamable HTTP MCP 接口提供只读工具 `search_knowledge`。查询参数只有 `query`，阅读范围由宿主决定。TypeScript、Python 和 CLI 加载同一项目配置并访问同一服务。

## 第一次查询

按[运行示例](../../../examples/modules/manage-knowledge/README.zh-CN.md)准备环境并运行三个入口。用公开身份查询“ST-17 拼接地图现在由哪一个窗口受理？”。在结果中找到“榆木台”，打开[二版索引](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v2.md)核对第 6 行。相同编号在[一版索引](../../../examples/knowledge-evals/zh-retrieval/sources/流转索引-v1.md)也出现在第 6 行，但窗口为“榛果台”。只核对行号会把旧结果判为正确。

找到了相似条目时，逐项确认摘录支持答案。没有可采信出处时，应告知读者资料不足。替换检索组件时，沿用[开发 SOP](SOP.zh-CN.md)中的问题、权限和版本对照。
