# Runtime 生命周期扩展

状态：\`0.3.0-rc.1\` 发布候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

本模块允许宿主在不修改 Runtime 核心逻辑的前提下导出 Trace 或附加拒绝策略。第一版刻意只有四个只读事件，不扫描项目目录，也不提供扩展市场、任意内部对象访问或“批准工具”的能力。

| 事件 | 发生时机 | 允许的用途 |
|---|---|---|
| `before-model` | Context 保护和模型请求前 | 只读审计、统计 |
| `before-tool` | 通用权限已允许、Checkpoint 创建前 | 只读审计或附加拒绝 |
| `after-tool` | 工具结果、Artifact、Checkpoint 和预算证据形成后 | 结果导出、统计 |
| `run-finished` | operation 已进入真实终态后 | 终态导出、告警 |

## 公共接口

- `defineLifecycleExtension()`：校验扩展 id、版本、能力和 handler。
- `LifecycleExtensionHost`：按 id 稳定排序并执行显式信任的扩展。
- `createTraceExporterExtension()`：四事件只读导出示例。
- `createDenyPolicyExtension()`：`before-tool` 附加拒绝示例。
- `CoreMindRuntimeOptions.lifecycleExtensions`：宿主注册、信任、授权与超时配置。
- `RunResult.extensions` 与 `extension_lifecycle`：可审计执行收据。

## 信任与威胁模型

扩展代码运行在宿主进程内，因此“显式注册”本身就是代码信任决定。能力声明不是操作系统沙箱：它用于准入、最小授权和审计，不能约束一段已经被宿主直接执行的恶意 JavaScript。需要强隔离时，应在独立进程或受控执行环境中运行集成，再通过稳定工具或协议接入。

框架强制以下不变量：

- 未出现在 `trustedIds` 中的扩展拒绝加载。
- 扩展请求的文件、进程、网络、凭据或 UI 能力必须被 `grants` 完整覆盖。
- 没有凭据能力时，payload 中疑似密钥字段会被替换为 `<redacted>`。
- handler 收到深冻结副本，不能修改 Runtime 对象。
- 超时与异常只记录 `failed`/`timed_out` 收据，不抛回 Runtime。
- `before-tool` 只能附加 deny，不能覆盖通用权限拒绝或人工拒绝。
- `run-finished` 只能观察已经确定的 operation、outcome 和质量结果，不能伪造成功。

## 明确边界

这不是安全沙箱、插件商店、项目自动信任机制或第二套 Runtime。CoreMind 不自动加载工作区内的未知代码，不向扩展传递 Provider 私有对象，也不承诺扩展崩溃恢复。公开扩展前请执行 [开发 SOP](SOP.zh-CN.md) 和 [示例](../../../examples/modules/extend-runtime-lifecycle/README.zh-CN.md)。
