# coremind-runtime

CoreMind 的智能体运行时，提供模型供应商解析、会话、工具调用、预算、检查点、上下文管理、质量评估、静态 Workflow 和显式有界 Loop。

所有调用统一返回成功、失败、暂停、中止、超时或预算耗尽终态。`LoopController` 封装内部状态机，提供 verify/repair、无进展检测、稳定快照和暂停恢复；只有验证通过才返回成功。

工具副作用记录 `started`、`committed` 或 `unknown` Effect Receipt。恢复不重复完整步骤和已提交副作用，未知副作用要求人工核对。文件恢复还会检查工具执行后的指纹，拒绝覆盖用户或并发进程的后续修改。

Evaluation schemaVersion 2 提供 outcome、trajectory、command、file、diff、state、response 七类 grader，并在执行前记录受保护文件与脏工作区基线。一次 Runtime 成功、一次预期测试失败、最终代码正确和是否可以发布是不同结论，必须分别记录。

Trace 事件在持久化和转发前统一脱敏：密钥、Token、口令、认证头、Cookie、私钥、URL 敏感参数和命令中的敏感值不进入 RunState；正常测试命令仍保留可审查性。该防线不代替本地文件访问控制和业务数据保留策略。

该包适合需要组合底层运行能力的框架扩展者。面向业务开发时，建议从 `coremind-ai` 的稳定入口开始，避免直接依赖内部模块。

> 当前为预发布版本。公开 API、配置结构和执行语义仍可能按发布说明调整，请在升级前阅读变更日志。

安全边界与平台差异见[安全策略](https://github.com/Eclipseic1848/CoreMind/blob/main/SECURITY.md)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
