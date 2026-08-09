# coremind-tools

CoreMind 的内置工具注册表、自定义 TypeScript/Python 工具加载器与平台安全适配层。公共能力还包括受控 `ProcessRunner`、只读 `GitAdapter` 和有输入/输出/复杂度上限的统一 Diff。

所有自定义工具都必须声明输入、输出和结构化副作用，且不能冒用内置工具名。高风险工具应使用“请求批准”模式；Linux 内置 Shell 可启用操作系统级隔离。Windows 当前不提供同等级 Shell 隔离，宿主 Shell 只有在 full、关闭工作区限制、允许网络三项同时明确选择时开放；其他组合使用路径感知文件工具或隔离的 Linux 环境。

`ProcessRunner` 使用命令与参数数组，不启用 Shell 拼接，并提供超时、中止、UTF-8 输出上限和最小环境变量控制。`GitAdapter` 只开放 status/diff/log，不提供仓库写操作。Diff 会拒绝工作区外路径、链接逃逸和超限文本。

开始实现工具前，请先阅读[安全策略](https://github.com/Eclipseic1848/CoreMind/blob/main/SECURITY.md)和[权限模块文档](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/enforce-agent-permissions)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
