# 配置与 Schema

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用一份可校验的 coremind.yaml 描述 Agent、工具、工作流、预算、权限和质量档。

## 公共接口

- `loadConfigFile`
- `parseConfigText`
- `parseAndValidate`
- `validateConfig`

## 错误与边界

- ConfigParseError：文件或 YAML/JSON 语法无效
- ConfigValidationError：配置不符合 v2 Schema

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-config/src](../../../packages/coremind-config/src)
- [packages/coremind-config/src/parse.test.ts](../../../packages/coremind-config/src/parse.test.ts)
- [packages/coremind-config/src/validate.test.ts](../../../packages/coremind-config/src/validate.test.ts)
- [模块示例](../../../examples/modules/configure-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/configure-coremind/README.en.md)
- [Agent Skill](../../../skills/configure-coremind/SKILL.md)
