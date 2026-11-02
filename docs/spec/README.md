# CoreMind 架构规格索引

本目录保存已经获得维护者确认、但不等同于实现或发布资格的架构合同。ADR 记录“为什么选择”，规格记录“必须满足什么”和“如何验收”；真实 Provider、GitHub Issue、产品代码、提交、发布仍需分别授权。

## 已发布基线

- [0.3.x-A：事实域与请求重建](0.3.x-a/01-fact-domains-and-request-rebuild.md)
- [0.3.x-A：类型化身份与关联不变量](0.3.x-a/02-identity-and-invariants.md)
- [0.3.x-A：取消收敛、输入收据与静止](0.3.x-a/03-cancellation-and-quiescence.md)
- [0.3.x-A：验收设计](0.3.x-a/04-acceptance-matrix.md)

## 可信 Harness 加固（#60～#73）

### 0.3.x-B：可信工具执行

- [可信工具执行合同](0.3.x-b/01-trusted-tool-execution.md)
- [故障注入与验收矩阵](0.3.x-b/02-acceptance-matrix.md)

### 0.3.x-C：长程上下文与观测证据

- [长程上下文生命周期](0.3.x-c/01-long-horizon-context-lifecycle.md)
- [本地可观测性与遥测外传](0.3.x-c/02-observability-and-egress.md)
- [上下文、观测与重放验收矩阵](0.3.x-c/03-acceptance-matrix.md)

### 0.4.x：Host 与 Protocol

- [Protocol v2 与 v1 迁移](0.4.x/01-protocol-v2-and-v1-migration.md)

### 0.7.x：Child Run 与多 Agent

- [Child Run 合同](0.7.x/01-child-run-contract.md)
- [0.7.0 P0：Child Run 产品化与稳定发布](0.7.x/02-p0-child-run-productization-and-stable-release.md)
- [宿主验收与同 Run 有限修正（0.8.0 已发布）](0.7.x/03-host-verification.md)

## 1.4.0 持久任务与会话合同

以下合同及能力已合入发布准备主线，正式交付仍须最终版本资格。Session 消息、Run 执行、Workspace checkpoint 与显式任务提交各有事实边界；Python 经同一 Worker 调用，不建设第二 Runtime 或事实库。

- [任务原子提交](../adr/0025-explicit-task-commit-authority.md)
- [阶段与显式迁移](../adr/0026-task-phases-and-migrations.md)
- [持久等待与唤醒](../adr/0027-durable-task-sleep-wake.md)
- [稳定键调用与结果复用](../adr/0028-keyed-task-calls.md)
- [公共会话树与分支](../adr/0029-public-session-tree-navigation.md)
- [跨语言可信任务宿主](../adr/0030-cross-language-task-session-host.md)

宿主负责可信定义注册、进程启动与 alarm；等待不扩展执行超时，未知外部效果不自动重放，不承诺分布式调度或外部 exactly-once。使用及验收入口见[任务指南](../guides/durable-tasks.zh-CN.md)与[1.2→1.4 迁移](../migrations/1.2-to-1.4.zh-CN.md)。

## 状态口径

- `proposed`：仍有关键合同待确认。
- `accepted`：设计已确认，可以进入独立授权的实现准备。
- 规格测试通过：只证明实现符合规格，不等于真实 Provider、产品验收或发布资格。
