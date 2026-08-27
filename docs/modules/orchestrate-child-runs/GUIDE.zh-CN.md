# Child Run 使用指南

## 何时使用

只有子任务需要独立模型执行、预算、权限、恢复与结果时才使用 Child Run。普通并行工具、Workflow Step 和 MCP Tool 返回不应自动升级为 Child Run。

## 接入顺序

1. 为父 Runtime 配置有限的 `maxTokens` 与 `maxCostUsd`。
2. 构造不宽于父级的 `ChildRunDelegationRequest`，使用稳定 DelegationId。
3. Adapter 工厂创建真实 `CoreMindRuntime` 时必须传入相同 `childRunAuthority`、ChildRunId、AbortSignal、task 和 canonical cwd。
4. 调用 `delegateChildRun()`，保存 Handle，并在结构化 join 点调用 `join()`。
5. 读取 `RunResult.childRuns`、Protocol v2 query 或 TUI `/children`，不要读取 Coordinator 内部 Map。

## 结果与恢复

结果包含 outcome、证据引用、Artifact、Workspace changes 和未决风险。自然语言摘要不是唯一结果。恢复遇到 orphan 时先审计实际进程、工具、Lease 和关键 Fact；不得自动重新执行同一委派。

## 平台说明

Linux sandbox 可通过探针证明受控能力。Windows Trusted Host 只提供受信任宿主能力，不能宣称 sandbox 或 controlled egress。需要这些能力时应暂停并更换已验证执行环境。
