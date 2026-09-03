# coremind-worker

CoreMind 的本地 Node.js Worker，通过标准输入输出协议向 Python SDK 提供与 TypeScript 入口一致的运行能力。

该包通常由 Python 构建流程自动打包和调用，不建议业务代码直接启动。协议消息写入标准输入，业务日志必须写入标准错误，避免破坏消息通道。

跨语言一致性由黄金样例和 Wheel 安装测试共同验证，包括显式 Loop 的状态顺序、暂停恢复与终态。详见[Python 嵌入模块](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/modules/embed-coremind-python)。

工具注册必须携带结构化副作用；初始化或注册失败时 Python 客户端会关闭 Worker，避免遗留子进程。

协议能力声明包含 `loop` 与 `runSnapshot`；每个运行返回同一纯 JSON 权威快照。`resume_run` 可继续安全的暂停或意外中断运行，但不会绕过配置指纹、Effect Receipt 或副作用核对。

`ProtocolHost` 同时承载 v1 兼容入口与 v2。v2 start 立即返回 `RunHandle`，后台运行继续写入同一 Runtime Facts；`events` 按 durable sequence 分页，`query` 只调用 `ProjectionEngine`，`control` 只通过 Runtime 的持久 `ControlInbox`。连接写失败与慢消费者不会反向污染运行状态；可重放 live event 在有界 stdio 队列溢出时可丢弃，RPC 响应和控制回执不可丢弃。Host 重启可从 start/resume Fact 重建幂等身份，过期 cursor 返回 Projection snapshot 与受控新游标。

`0.7.1` 继续提供 v1，并与 v2 共享同一个 Node Runtime。当前没有批准的 v1 移除时间表；任何移除都必须经过独立、版本化的弃用决策。未知版本或同连接混用协议 envelope 会失败关闭。

## English: ProtocolHost

`ProtocolHost` serves both the v1 compatibility entry and v2 while preserving one Node Runtime. A v2 start returns a RunHandle immediately as background execution keeps writing the same Runtime facts. Events are paged by durable sequence, queries only invoke ProjectionEngine, and controls only pass through the Runtime's durable ControlInbox. Transport failures and slow consumers cannot mutate authoritative run state; replayable live events may be dropped from the bounded stdio queue, while RPC responses and control receipts are never dropped.

The Host rebuilds idempotent start identity from start/resume facts after restart and returns a Projection snapshot plus a controlled cursor when retained history has expired. Unknown protocol versions and mixed envelopes fail closed. Version `0.7.1` continues to support v1, and no removal schedule has been approved; removal requires a separate, versioned deprecation decision.

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
