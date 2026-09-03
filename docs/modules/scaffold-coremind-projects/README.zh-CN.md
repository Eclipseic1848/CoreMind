# 模板与项目文档

状态：随 `0.7.0` 稳定版发布；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

根据新建或已有工程生成语言匹配的代码骨架、测试、评测、双语文档、SOP 和项目 Skill，且不覆盖原文件。

## 公共接口

- `detectProjectLanguage`
- `scaffoldProjectGuidance`
- `coremind create`

## 错误与边界

- 混合或空工程不猜语言
- 使用 wx 写入，已有文件不会覆盖
- 业务规则保留为需负责人确认的明确项

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-templates/src/project-scaffold.ts](../../../packages/coremind-templates/src/project-scaffold.ts)
- [packages/coremind-templates/templates](../../../packages/coremind-templates/templates)
- [packages/coremind-templates/src/project-scaffold.test.ts](../../../packages/coremind-templates/src/project-scaffold.test.ts)
- [packages/coremind-templates/src/templates.test.ts](../../../packages/coremind-templates/src/templates.test.ts)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [模块示例](../../../examples/modules/scaffold-coremind-projects/README.zh-CN.md)
- [Module example](../../../examples/modules/scaffold-coremind-projects/README.en.md)
- [Agent Skill](../../../skills/scaffold-coremind-projects/SKILL.md)
