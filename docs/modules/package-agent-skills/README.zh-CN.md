# Skill 与 SOP 装载

2.0.0 支持项目 Skill 和资源复用。2.1.0 候选将固定版本安装器随模板包交付。模块支持 Windows 和 Linux。

## 目的

按 Agent 的 `skills` ID 选择可复用的专业流程。内置 Skill 和旧 README 保持全文注入。配置目录下的标准 `SKILL.md` 先进入索引，再由 `load_skill({id})` 返回正文。资源包通过 `load_skill({id, resource})` 按需提供声明文件。业务事实仍由项目文档提供。

一个只用 Skill 的项目需要一个可运行的 Agent、配置旁的 `skills/<id>/SKILL.md` 和该 Agent 的 `skills` 选择。使用者可以直接创建这些文件，独立更新 Skill。读取标准 Skill 使用 Runtime 提供的 `load_skill`，不需要另配业务工具、知识库、Hindsight 或本体服务。见[最小项目与停用步骤](GUIDE.zh-CN.md)。

## 公共接口

- `resolveSkills`
- `loadDirectorySkills`
- `SKILLS`

应用通过现有 Runtime 使用标准 Skill，通过候选 `coremind-templates` 包提供的 `coremind-skill-install` 将固定 Git 版本安装到项目。详见[安装和回退指南](GUIDE.zh-CN.md#固定版本安装和回退)。

## 错误与边界

- 缺失 Skill 会告警并继续，不会伪装成已加载
- 同 ID 时内置 Skill 优先；同目录 SKILL.md 优先于 README.md，双文件告警，损坏不回落
- 单个项目源文件最多 256 KiB；每次解析结果及全部 Agent 的冻结快照分别最多 2 MiB 序列化 UTF-8 JSON
- 只解析配置目录 `configDir` 下显式选择的 ID；路径越界、读取变化和无效编码明确失败
- `coremind.skill.json` 声明可读资源及其原始字节 SHA-256。声明路径和目标均须通过边界检查，脚本按文本提供
- 加载经过 ToolPolicy、审批及预算。正文或资源离开最终工作集后可从原快照重载

标准 Skill 在 Runtime、Child 与恢复中使用版本化冻结内容。新 Runtime 读取当前安装版本。原始 Store 保存正文与资源，公开投影和导出剥离 Skill 私有字段。完整对话恢复还需要 Session 和压缩记录。SHA 用于验证一致性。

格式、原始 64 字符十六进制 SHA 与其他恢复边界见[技能指南](../../guide/03-skills.md)。

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-templates/src/skills.ts](../../../packages/coremind-templates/src/skills.ts)
- [packages/coremind-templates/skills](../../../packages/coremind-templates/skills)
- [packages/coremind-templates/src/skills.test.ts](../../../packages/coremind-templates/src/skills.test.ts)
- [标准解析器](../../../packages/coremind-templates/src/standard-skills.ts)与[解析回归](../../../packages/coremind-templates/src/standard-skills.test.ts)
- [冻结与加载 helper](../../../packages/coremind-runtime/src/skill-runtime.ts)及[单测](../../../packages/coremind-runtime/src/skill-runtime.test.ts)
- [Runtime 验收](../../../packages/coremind-runtime/src/skills-runtime.acceptance.test.ts)
- [固定版本安装器回归](../../../examples/modules/package-agent-skills/install-skill.test.mjs)
- [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)
- [Module example](../../../examples/modules/package-agent-skills/README.en.md)
- [Agent Skill](../../../skills/package-agent-skills/SKILL.md)
