# coremind-protocol

CoreMind TypeScript 运行时与 Python SDK 共用的 JSON-RPC 协议、消息类型和运行时校验器。

本包主要服务于跨语言适配器和自定义 Worker 开发。业务应用通常无需直接依赖它，请优先使用 `coremind-ai` 或 Python 包 `coremind-ai`。

工具注册消息包含强制 `effect` 副作用声明。配置可以携带公开 `loop` 字段，事件流通过 `loop_state` 暴露稳定状态，但不暴露内部状态机实现。`resume_run` 同时支持安全的暂停与意外中断恢复。

任何不兼容协议变更必须同步升级 TypeScript、Python、内置 Worker 和协议标识，并通过跨语言与黄金样例测试；不得只更新一端。贡献流程见[贡献指南](https://github.com/Eclipseic1848/CoreMind/blob/main/CONTRIBUTING.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
