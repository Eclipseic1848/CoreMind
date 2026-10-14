# Skill 与 SOP 装载

状态：本文覆盖 1.1 开发线的标准技能与旧格式兼容合同；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

把可复用的专业流程按 Agent 的 `skills` ID 选择。内置技能和旧 README 仍全文进入稳定前缀；配置目录下的标准 SKILL.md 先进入索引，再经 `load_skill` 按需返回正文。业务事实仍由项目文档提供。

## 公共接口

- `resolveSkills`
- `loadDirectorySkills`
- `SKILLS`

这些既有根接口保持不变；标准加载由 Runtime 接线，不新增用户必须调用的解析 API。

## 错误与边界

- 缺失 Skill 会告警并继续，不会伪装成已加载
- 同 ID 时内置 Skill 优先；同目录 SKILL.md 优先于 README.md，双文件告警，损坏不回落
- 单个项目源文件最多 256 KiB；每次解析结果及全部 Agent 的冻结快照分别最多 2 MiB 序列化 UTF-8 JSON
- 只解析配置目录 `configDir` 下显式选择的 ID；路径越界、读取变化和无效编码明确失败
- 加载仍经过 ToolPolicy、审批及预算，不增加任何工具权限；正文离开最终工作集后允许从原快照重载

标准技能在 Runtime、Child 与恢复中使用冻结内容；源文件后续修改不在同一 Runtime 中热更新。原始 Store 受信且含正文，公开投影和导出剥离技能私有字段。关闭 Session 不代表可恢复完整对话；一致性 SHA 也不是防宿主改写的签名。

格式、原始 64 字符十六进制 SHA 与恢复边界见[技能指南](../../guide/03-skills.md)。不提供远程发现、脚本执行或技能市场。

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-templates/src/skills.ts](../../../packages/coremind-templates/src/skills.ts)
- [packages/coremind-templates/skills](../../../packages/coremind-templates/skills)
- [packages/coremind-templates/src/skills.test.ts](../../../packages/coremind-templates/src/skills.test.ts)
- [标准解析器](../../../packages/coremind-templates/src/standard-skills.ts)与[解析回归](../../../packages/coremind-templates/src/standard-skills.test.ts)
- [冻结与加载 helper](../../../packages/coremind-runtime/src/skill-runtime.ts)及[单测](../../../packages/coremind-runtime/src/skill-runtime.test.ts)
- [Runtime 验收](../../../packages/coremind-runtime/src/skills-runtime.acceptance.test.ts)
- [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)
- [Module example](../../../examples/modules/package-agent-skills/README.en.md)
- [Agent Skill](../../../skills/package-agent-skills/SKILL.md)
