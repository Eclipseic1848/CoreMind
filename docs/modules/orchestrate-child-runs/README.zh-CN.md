# 编排 Child Run

状态：随 `0.7.0` 稳定版发布；支持平台：Windows、Linux。

Child Run 是由父 Run 委派的完整 Run，不是普通 Tool Call。它拥有独立 RunId、事实、预算、权限、结果和静止状态，并通过 ParentRunId、ChildRunId、DelegationId 与父级关联。

## 已实现合同

- 同一 DelegationId 与输入指纹幂等复用；不同输入失败关闭。
- 模型、canonical Workspace、Context 引用、权限、工具、路径、凭据、执行环境和多维预算只能维持或收紧。
- 默认最大深度 3、活动子级 4、总后代 32；无限或负值被拒绝。
- 父取消传播并结构化 join；子取消不反向取消父级；join timeout 会取消并等待清理。
- 恢复时无法确认所有权的子级会在任何新 Provider 请求前持久化 `child_orphaned → parent_joined` 并进入人工 orphan audit pause，不自动重启。
- 成功 join 仅在执行静止、所有权释放且没有 started/unknown Effect 时默认接受；committed Effect 可以随成功结果接受，但不能证明可安全重新委派。其他终态或带未决风险的异常成功结果必须记录接受风险、替代方案、重新委派或传播终态之一，父级才能继续或结束。
- 重新委派必须由安全 RecoveryDisposition 证明，并使用关联的新 DelegationId 与新预算；同一身份永不自动重跑。
- 父 Run 在 successor 创建前形成自身终态时，会持久撤销待执行的重新委派，不再请求 Provider。
- 暂停 Run 可离线持久接收人工 Disposition 控制，恢复并重建 Coordinator 后才应用。
- `child_paused`、`child_terminal`、`child_orphaned` 与 `parent_joined` 由同一生命周期 reducer 校验；倒退 Fact 视为损坏。
- `ProjectionEngine.projectTree()` 从父子各自的 canonical Facts 重建树、结果和真实 Workspace Lease 事件。
- Protocol v2、Worker、TypeScript `RunResult`、CLI JSONL 与 TUI `/children` 使用同一投影。

## 安全边界

Runtime 会用实际 Provider/model、canonical cwd、权限、工具集合、执行环境探针和运行预算验证父策略。真实 Child Runtime 在执行前还必须绑定同一个委派对象、RunId、AbortSignal 和任务输入。Windows Trusted Host 不能证明 sandbox 或 controlled egress；声明这些要求会失败关闭。

当前不支持 durable detach。`detach: forbidden` 是唯一可执行策略；没有 Job 所有权转移与恢复证据时，不能让子级脱离父生命周期。

## 证据

- [Child Run 深模块](../../../packages/coremind-runtime/src/child-run.ts)
- [真实 Runtime Adapter](../../../packages/coremind-runtime/src/child-runtime-adapter.ts)
- [ADR 0008](../../adr/0008-subagents-as-child-runs.md)
- [0.7.x 规格](../../spec/0.7.x/01-child-run-contract.md)
- [使用指南](GUIDE.zh-CN.md)
- [运维 SOP](SOP.zh-CN.md)
- [示例](../../../examples/modules/orchestrate-child-runs/README.zh-CN.md)

发布证据覆盖离线合同、本地 Runtime、跨进程故障、双平台 CI 与候选包；`0.7.0` 的 Provider 网络例外不构成 live-provider 认证。
