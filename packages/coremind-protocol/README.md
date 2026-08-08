# coremind-protocol

CoreMind TypeScript 运行时与 Python SDK 共用的 JSON-RPC 协议、消息类型和运行时校验器。

本包主要服务于跨语言适配器和自定义 Worker 开发。业务应用通常无需直接依赖它，请优先使用 `coremind-ai` 或 Python 包 `coremind-ai`。

协议变更必须保持向后兼容，并同时通过 TypeScript、Python 和黄金样例测试。贡献流程见[贡献指南](https://github.com/Eclipseic1848/CoreMind/blob/main/CONTRIBUTING.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
