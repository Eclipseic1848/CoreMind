# coremind-runtime

CoreMind 的智能体运行时，提供模型供应商解析、会话、工具调用、预算、检查点、上下文管理、质量评估、静态 Workflow 和显式有界 Loop。

所有调用统一返回成功、失败、暂停、中止、超时或预算耗尽终态。`LoopController` 封装内部状态机，提供 verify/repair、无进展检测、稳定快照和暂停恢复；只有验证通过才返回成功。

工具副作用记录 `started`、`committed` 或 `unknown` Effect Receipt。恢复不重复完整步骤和已提交副作用，未知副作用要求人工核对。文件恢复还会检查工具执行后的指纹，拒绝覆盖用户或并发进程的后续修改。

Runtime 在 Policy 与 Checkpoint 前为每个 Call 记录一次 `capability_resolved` Fact，并让后续消费者复用同一份冻结 Capability。`projectToolCapabilities()` 为 CLI、TUI、TypeScript 和 Python 提供统一投影；读取 0.3.0/0.3.1 历史记录时，缺少该 Fact 的 Call 显式标记为 `legacy`、`unknown` 与 `requires_human`，不会根据旧工具名补写安全结论。

所有当前工具入口经过 `ToolExecutionEngine` 的唯一阶段 reducer：从 `call_recorded` 依次推进到 `terminal`，不需要的阶段也会记录 `skipped(reason)`。执行结果、Effect、持久化、恢复、清理、授权和环境是相互独立的结果轴；取消或超时会收敛开放 Call，迟到结果不能改写已持久终态。`projectToolCallLifecycles()` 是 Runtime、Worker 和 SDK 共用的离线投影。Durability Barrier 的能力协商与平台承诺、Workspace Lease 的互斥和跨进程清理仍由后续加固阶段交付，本包不提前声称这些保障已经完成。

人工或策略拒绝工具后，当前智能体循环会在本批工具结果完成归并后立即暂停，不再请求下一轮模型或重复申请审批。拒绝仍记录为 `tool_approval_denied`，且被拒绝的工具不会产生副作用。

Evaluation schemaVersion 2 提供 outcome、trajectory、command、file、diff、state、response 七类 grader，并在执行前记录受保护文件与脏工作区基线。一次 Runtime 成功、一次预期测试失败、最终代码正确和是否可以发布是不同结论，必须分别记录。

Trace 事件在持久化和转发前统一脱敏：密钥、Token、口令、认证头、Cookie、私钥、URL 敏感参数和命令中的敏感值不进入 RunState；正常测试命令仍保留可审查性。该防线不代替本地文件访问控制和业务数据保留策略。

该包适合需要组合底层运行能力的框架扩展者。面向业务开发时，建议从 `coremind-ai` 的稳定入口开始，避免直接依赖内部模块。

> 当前为预发布版本。公开 API、配置结构和执行语义仍可能按发布说明调整，请在升级前阅读变更日志。

安全边界与平台差异见[安全策略](https://github.com/Eclipseic1848/CoreMind/blob/main/SECURITY.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
