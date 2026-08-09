# coremind-ai

CoreMind 的 TypeScript/JavaScript 统一 SDK 门面。请只从 `coremind-ai` 导入公共 Config、Protocol、Runtime、Tool、Session、Checkpoint、RunState 恢复和 Evaluation 接口，不要依赖 monorepo 内部路径。

Unified TypeScript/JavaScript SDK facade for CoreMind. Import public configuration, protocol, runtime, tool, session, checkpoint, safe-resume, and evaluation APIs from `coremind-ai` only.

运行结果统一为六种终态；公共入口导出 `LoopConfig`、`LoopPhase`、稳定恢复能力、七类 Evaluation grader、`ProcessRunner`、只读 `GitAdapter` 和统一 Diff，自定义工具必须声明结构化副作用。Run results use six terminal states; the facade exports `LoopConfig`, `LoopPhase`, stable resume APIs, seven evaluation grader types, `ProcessRunner`, read-only `GitAdapter`, and unified diffs, while custom tools require structured effect declarations.

完整文档 / Full documentation: https://github.com/Eclipseic1848/CoreMind
