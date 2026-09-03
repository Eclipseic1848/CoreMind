# Skill 与 SOP 装载

状态：随 `0.7.0` 稳定版发布；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

把可复用的专业流程写成精简 Skill，并按 Agent 配置注入，业务事实仍由项目文档提供。

## 公共接口

- `resolveSkills`
- `loadDirectorySkills`
- `SKILLS`

## 错误与边界

- 缺失 Skill 会告警并继续，不会伪装成已加载
- 同名时内置 Skill 优先

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-templates/src/skills.ts](../../../packages/coremind-templates/src/skills.ts)
- [packages/coremind-templates/skills](../../../packages/coremind-templates/skills)
- [packages/coremind-templates/src/skills.test.ts](../../../packages/coremind-templates/src/skills.test.ts)
- [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)
- [Module example](../../../examples/modules/package-agent-skills/README.en.md)
- [Agent Skill](../../../skills/package-agent-skills/SKILL.md)
