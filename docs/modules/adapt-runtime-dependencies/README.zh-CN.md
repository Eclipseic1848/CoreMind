# Runtime 依赖 Adapter

状态：合同与文档已对齐 `1.0.0` 发布线；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

把模型流式调用、消息、工具、Usage 和错误分类集中在 CoreMind 私有 Adapter seam，避免新手或业务代码依赖底层实现细节。核心依赖必须使用同一精确版本族，任何版本漂移都会被 CI 阻断。

## 公共接口

- `inspectRuntimeCompatibility()`：以 CoreMind 自有结构返回依赖族、Adapter 版本、错误映射版本和能力状态。
- `coremind doctor`：展示兼容层状态，但不要求用户在配置中理解或填写底层版本。
- `CoreMindMessage`、`CoreMindToolDefinition`：SDK 公开合同只使用 CoreMind 自有类型；私有运行依赖不会出现在根入口声明中。

## 不变量

- 核心依赖安装树只能存在一个版本族。
- Provider、工具、abort、usage、错误和超时必须通过显式转换或合同测试。
- CoreMind 对用户继续返回稳定的 `session.dir/<id>.jsonl` 路径；底层仓库布局不能改写 CLI/SDK 的文件合同。
- 不用双重强转掩盖跨版本类型冲突。
- SDK 不使用 shrinkwrap；仓库 overrides 不约束下游消费者。发布验收在 tarball 干净安装后逐层核对实际运行依赖图的七个成员，保留原有导入、Child Run 与内容门禁。
- Python 内置 Worker 的 manifest 记录七个成员的实际安装版本、锁定归档完整性及构建输出中的 `bundled` 状态；已解析的成员不等于已内联。wheel 与冻结源码中的 Worker/manifest 逐字节核对，消费者 npm 图与随包 Worker 分别验收。
- 依赖升级失败时整体回退，禁止混搭进入主线。
- 候选基线采集会扫描 `coremind-runtime` 和 `coremind-ai` 的聚合声明；发现私有依赖类型即阻断。

## 源码、测试与证据

- [Runtime Adapter](../../../packages/coremind-runtime/src/dependency-adapter.ts)
- [会话兼容 Adapter](../../../packages/coremind-runtime/src/session.ts)
- [工具注册表](../../../packages/coremind-tools/src/registry.ts)
- [依赖锁步测试](../../../scripts/dependency-lockstep.test.ts)
- [依赖报告测试](../../../scripts/dependency-report.test.ts)
- [依赖升级 Spike 模板](DEPENDENCY-UPGRADE-SPIKE-TEMPLATE.zh-CN.md)
- [候选依赖报告](../../../baselines/0.3.0-candidate/dependency-report.json)
- [模块示例](../../../examples/modules/adapt-runtime-dependencies/README.zh-CN.md)
- [Module example](../../../examples/modules/adapt-runtime-dependencies/README.en.md)
- [Agent Skill](../../../skills/adapt-runtime-dependencies/SKILL.md)

CoreMind 负责 Adapter、运行合同和质量门禁；业务负责人仍负责模型选择、数据边界、费用和最终验收。
