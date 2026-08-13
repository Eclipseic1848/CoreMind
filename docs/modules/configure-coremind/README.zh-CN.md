# 配置与 Schema

状态：尚未发布的 `0.3.0` 稳定候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用一份可校验的 coremind.yaml 描述 Agent、工具、Workflow 或显式 Loop、预算、权限和质量档。

自定义脚本工具必须通过 `effect` 声明读取、写入、进程、网络或外部副作用；缺失声明时配置校验直接失败，权限层不会猜测。

## 公共接口

- `loadConfigFile`
- `parseConfigText`
- `parseAndValidate`
- `validateConfig`
- `ToolEffectDeclarationSchema`
- `LoopConfigSchema`

## 错误与边界

- ConfigParseError：文件或 YAML/JSON 语法无效
- ConfigValidationError：配置不符合 v2 Schema
- `workflow` 与 `loop` 同时出现、Loop 引用未知 Agent 或边界参数无效时，在运行前拒绝

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-config/src](../../../packages/coremind-config/src)
- [packages/coremind-config/src/parse.test.ts](../../../packages/coremind-config/src/parse.test.ts)
- [packages/coremind-config/src/validate.test.ts](../../../packages/coremind-config/src/validate.test.ts)
- [模块示例](../../../examples/modules/configure-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/configure-coremind/README.en.md)
- [Agent Skill](../../../skills/configure-coremind/SKILL.md)
