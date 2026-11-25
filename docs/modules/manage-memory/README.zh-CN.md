# 长期记忆与经验提炼

任何支持 Streamable HTTP MCP 的应用都可以单独接入记忆网关。宿主运行 Hindsight OSS 1.2.3 和 PostgreSQL，业务项目持读令牌调用 `recall_memory(query)`。同一主体在新会话中可以召回已确认的偏好，更正后再查询可以得到新版本。

宿主确定项目、主体、Agent 和会话分支，管理写入确认、更正、遗忘和经验是否生效。模型使用只读工具召回当前可见的记忆。会话历史、运行记录和知识资料仍按各自的数据合同管理。

CoreMind 2.0.0 的[正式源码 ZIP](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0)提供网关脚本和固定依赖，可将记忆目录单独解压到宿主管理的服务目录。CLI 和 SDK 是可选调用端。独立可安装的网关软件包及其版本升级流程属于后续建设。

[接入指南](GUIDE.zh-CN.md)和[可运行示例](../../../examples/modules/manage-memory/README.zh-CN.md)说明记忆的权限和使用过程。[开发 SOP](SOP.zh-CN.md)列出验收条件，实现和测试路径见[模块清单](module.yaml)。
