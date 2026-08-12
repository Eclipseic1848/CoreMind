# 上下文与 Artifact 治理

状态：`0.3.0-rc.2` 发布候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 这个模块解决什么问题

长任务会同时遇到两个相反风险：上下文无限增长会超过模型窗口，粗暴截断又可能丢掉未完成任务、权限决定或失败证据；工具大输出直接送入模型会浪费 token，也可能泄漏凭据。本模块把“模型需要看到的内容”和“审计需要保留的完整输出”分开治理。

## 稳定合同

| 能力 | 模型可见内容 | 完整证据 |
|---|---|---|
| 稳定前缀 | 固定顺序的核心规则、项目指令、工具、事实和 Skill | SHA-256 指纹进入 Trace 与指标 |
| 上下文压缩 | 本地确定性摘要与最近完整轮次 | 压缩原因、前后 token、摘要指纹 |
| 大输出 | 有界开头、结尾、字节摘要和 Artifact 相对引用 | `.coremind/artifacts/*.log`、大小、哈希、媒体类型 |
| 缓存 | Provider 是否声明支持、实际读写 token | 原始 usage 汇总；零命中仍为零 |

摘要固定保留目标、约束、审批、已修改文件、测试状态、未完成任务、下一步和不确定副作用。压缩在每次 Provider 请求前检查，因此长 Loop 不会只在任务开始时判断一次。

## 安全边界

- Artifact 根目录解析后必须仍在工作区内，文件名只能由框架生成。
- 只有受信任的工具临时输出路径可被导入；伪造路径不会被读取或删除。
- 检测到疑似 API key、token、密码或私钥时，模型预览会被移除，临时文件与暂存 Artifact 都会删除。
- Artifact 是本地证据，不会自动上传，也不会自动变成跨项目记忆。
- `full` 权限模式不关闭上述路径和凭据保护。

## 公共接口

- `buildStableContextPrefix()`：生成逐字节稳定的前缀与指纹。
- `protectContext()`：执行确定性阈值压缩。
- `compareContextStrategies()`：离线比较策略，不改变默认值。
- `ArtifactStore`：流式导入、预览、哈希与定时清理。
- `RunMetrics.context` 与 `RunMetrics.artifacts`：提供可核验指标。

## 源码与证据

- [上下文实现](../../../packages/coremind-runtime/src/context.ts)
- [Artifact 实现](../../../packages/coremind-tools/src/artifact-store.ts)
- [50MB 与秘密阻断测试](../../../packages/coremind-tools/src/artifact-store.test.ts)
- [使用示例](../../../examples/modules/manage-context-artifacts/README.zh-CN.md)
- [开发 SOP](SOP.zh-CN.md)
- [可复用 Skill](../../../skills/manage-context-artifacts/SKILL.md)
