# coremind-tools

CoreMind 的内置工具注册表、自定义 TypeScript/Python 工具加载器与平台安全适配层。

所有工具都必须声明输入、输出和权限边界。高风险工具应使用“请求批准”模式；Linux 内置 Shell 可启用操作系统级隔离，Windows 当前不提供同等级 Shell 隔离。

开始实现工具前，请先阅读[安全策略](https://github.com/Eclipseic1848/CoreMind/blob/main/SECURITY.md)和[权限模块文档](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/enforce-agent-permissions)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
