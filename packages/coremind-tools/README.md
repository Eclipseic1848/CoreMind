# coremind-tools

CoreMind 的内置工具注册表、自定义 TypeScript/Python 工具加载器与平台安全适配层。公共能力还包括受控 `ProcessRunner`、只读 `GitAdapter` 和有输入/输出/复杂度上限的统一 Diff。

所有自定义工具都必须声明输入、输出和结构化副作用，且不能冒用内置工具名。高风险工具应使用“请求批准”模式；Linux 内置 Shell 可启用操作系统级隔离。Windows 当前不提供同等级 Shell 隔离，宿主 Shell 只有在 full、关闭工作区限制、允许网络三项同时明确选择时开放；其他组合使用路径感知文件工具或隔离的 Linux 环境。

自定义工具对可预期的业务或执行失败应抛出公开的 `ToolExecutionError`；Runtime 会把它作为已登记的 `tool_execution_failed` 工具结果交给 Agent，但不会自动重试。自定义工具抛出的裸异常属于未知 Adapter 故障，会收敛为需要人工处置的 `unclassified_error` 并暂停运行。内置工具也只在能够证明是预期失败的边界（例如进程正常返回非零退出码）生成该错误；其他裸异常不得伪装成已知失败，取消、超时等已有结构化错误码保持不变。

每个工具调用通过 `resolveToolCapability()` 得到不可变的 `ResolvedToolCapability`。内置工具只维护一份能力注册表，旧 `BUILTIN_TOOL_EFFECTS` 由它派生；已注册的旧式 `effect` 声明通过显式迁移适配生成保守能力。未注册、完整 Capability 缺字段、非法值、降权或互斥 Effect 冲突统一返回 `fallback`，不会按工具名猜测安全结论。网络读取属于 External Observable Read，不会投影为 Pure Local Read。

`ProcessRunner` 使用命令与参数数组，不启用 Shell 拼接，并提供超时、中止、UTF-8 输出上限和最小环境变量控制。调用方显式提供的 `env` 是权威环境：不会合并宿主密钥，也不会被工具执行上下文覆盖。`GitAdapter` 只开放 status/diff/log，不提供仓库写操作。Diff 会拒绝工作区外路径、链接逃逸和超限文本。Artifact 导入同时拒绝符号链接、链接目录和 canonical 路径逃逸，并在读取时核对已打开文件的身份，避免检查后替换目标。

开始实现工具前，请先阅读[安全策略](https://github.com/Eclipseic1848/CoreMind/blob/main/SECURITY.md)和[权限模块文档](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/enforce-agent-permissions)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)

## English: tool failure contract

Custom tools must throw the public `ToolExecutionError` for expected business or execution failures. Runtime exposes it to the Agent as the registered, non-retryable `tool_execution_failed` result. A bare exception from a custom or built-in Tool Adapter is an unknown failure: it converges to the pausing `unclassified_error` and requires human disposition. Built-in tools declare `ToolExecutionError` only at boundaries that prove an expected failure, such as a process returning a non-zero exit code; registered cancellation and timeout codes retain their existing meaning.
