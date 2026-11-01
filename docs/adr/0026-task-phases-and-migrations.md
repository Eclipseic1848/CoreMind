# ADR 0026：任务阶段与显式版本迁移

- 状态：1.4 开发线实现，发布资格仍取决于原安全门、双平台 CI 与合并。
- 关联：[#363](https://github.com/Eclipseic1848/CoreMind/issues/363)、[ADR 0025](0025-explicit-task-commit-authority.md)。

## 决策

公共 TypeScript `TaskSession` 是宿主驱动的持久阶段控制器。它复用 TaskCommit 的唯一原子事实与写租约，模型/工具调用沿用现有 `CoreMindRuntime`。旧 Workflow、Run 和 ChatSession 保持原有合同。

`start` 仅持久保存初始任务；`query` 只读复制投影；`resume` 最多执行一个阶段；`cancel` 取消当前阶段并提交取消状态。一个会话只接受一个写操作。完成或取消的任务再次 resume 返回原终态，不执行处理器或迁移。`close` 停止准入，取消活动阶段并等待已启动的受治理 Run 收敛后释放租约。

`TaskDefinition` 由宿主代码显式注册：type、正整数 version、initialPhase、checkpointSchema、阶段处理器与可选 migrate。阶段返回的 phase/checkpoint/document/entry 作为一次 TaskCommit 提交；状态推进不依赖内存返回值。恢复从已持久阶段的处理器顶部开始，不恢复任意 JavaScript 栈。错误保留最近检查点并标记 paused；取消不表示回滚已经发生的外部效果。

## 版本与权限

同版本定义指纹变化默认拒绝。较高版本须提供显式 migrate；迁移只得到旧状态副本和 AbortSignal，只允许返回 phase/checkpoint。Schema 校验成功后版本与状态原子提交，之后再执行阶段；失败不写任何迁移事实。已提交迁移不在重启后重复。降级不自动迁移。

Runtime 配置、权限、预算、工具声明与宿主注册函数组成独立身份，迁移不能改写它。`authorityVersion` 标识宿主闭包、外部策略与凭据路由；这些内容变化时宿主必须更新该版本。函数源码指纹不能识别闭包值或依赖模块行为；任务闭包语义变化时同样必须增加 TaskDefinition.version。注册代码是受信任宿主代码，不是 OS 沙箱。

## 模型、工具与失败窗口

处理器只获得 `context.run(prompt)`，没有裸工具/模型入口。每次阶段执行至多启动一个 Run；权限审批、预算、取消、critical Facts、Effect Receipt 和静止检查沿用现有 Runtime。Run 标识在调用 Runtime 之前先提交。只有 Run succeeded、已有副作用回执全部 committed 且 Runtime 已静止，阶段结果才可以提交。处理器吞掉失败也不能推进。

若进程在 Run 标识提交后、阶段提交前退出，保留 pendingRunId 并拒绝自动重发，即使真实调用可能尚未开始。这个保守窗口避免猜测外部效果；须检查原 Run 的事实。该版本不提供人工清除标识或任意覆盖事实的接口。多调用 key、结果缓存、自动协调与嵌套确定性恢复由 #365 独立实现；不宣称外部 exactly-once。

预算仍按每个 Run 计量；不宣称新增跨阶段累计预算。每次 resume 的受信任阶段代码沿用既有 stepTimeoutMs（默认 300000；显式 0 保留既有无限时语义），Runtime 自身所有超时不变。取消/超时后拒绝迟到的 context.run 和阶段结果；普通宿主 JavaScript 及其直接 I/O 不能由 AbortSignal 强制终止，处理器须协作取消并避免在治理入口之外产生业务副作用。

## 兼容、验证与回滚

只增加 TypeScript API；不改 Protocol v2、Python、Worker、错误总表、旧任务基础事实格式或旧 Config/Workflow/Run。任务状态封装有独立 format=1；未知封装拒绝执行。公共 TaskExecutionError 仅属于当前 TS 入口，跨语言接入属于 #367。

验证包括真实子进程 A 提交后退出、迁移提交后退出，原事实逐字节保全、取消/并发/Schema/定义及权限身份，以及本地 HTTP 模型下的权限拒绝、预算、外部效果未知和取消。固定子进程上限 10 秒、Vitest 上限 15 秒均不扩展。Windows 本地结果不替代 Linux CI。

回滚代码前关闭 TaskSession 并保留 `.coremind/tasks`；旧版本不会自动执行新任务封装。不要删除任务日志、重用旧 taskId 伪造新任务或在未知效果未确认时新建替代 Run。现有旧数据路径不需要迁移。

后续持久等待与幂等唤醒由 [ADR 0027](0027-durable-task-sleep-wake.md) 扩展；其新增状态的兼容与回滚约束以该 ADR 为准。

后续显式稳定键调用见 [ADR 0028](0028-keyed-task-calls.md)。原 context.run 未解决窗口规则保持；runCalls 在同一 Run 内按可证明的整步结果协调，不删除旧 pendingRunId 或绕过副作用证明。
