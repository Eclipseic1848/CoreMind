# coremind-templates

CoreMind 的场景模板、项目脚手架和模板索引。模板覆盖基础对话、内容处理、编码辅助、行业示例和工作流示例。

模板用于快速开始，不代表生产环境的业务规则。创建项目后，请根据真实业务补充权限、失败路径、质量门禁和评测样例。

```bash
npx coremind-cli@2.1.0 create my-agent
```

模板开发规范见[模块文档](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/scaffold-coremind-projects)。

2.0.0 的 `document-assistant` 是参考示例和组合回归，用于将知识引用、已确认记忆、Skill 和摘要写入放进一个项目，可选按本体检查发布条件。支持 CLI、TypeScript 和 Python 同步/异步。[中文使用说明](templates/general/document-assistant/README.md) · [English](templates/general/document-assistant/README.en.md)

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
