# ADR 0027：持久期限与幂等唤醒

- 状态：1.4 开发线实现，发布仍须通过原验收与全部安全门。
- 关联：[#364](https://github.com/Eclipseic1848/CoreMind/issues/364)、[ADR 0026](0026-task-phases-and-migrations.md)。

## 决策

继续使用 TaskSession、TaskCommit 和单 writer 租约。阶段返回 sleepUntil 后，把下一阶段、检查点、文档、entry 与 sleeping/sleepId/wakeAt 一起原子提交。只保存绝对 UTC epoch 毫秒期限和随机睡眠身份，不保存 Promise、JS 栈或 timer。期限限定非负 Date 整数范围；早到 resume 不执行处理器或迁移。

nextWake 从持久投影取最早期限；宿主建立普通 timer 或外部 alarm。宿主可信 clock 仅参与等待准入，不能改变原 Runtime/工具/阶段/Worker 超时。运行阶段与模型 Run 结束后才进入等待；等待不占用活动执行预算，也不建立全任务累计预算。

wake(taskId, wakeId, sleepId) 在一个 TaskCommit 中保存 ready 和该任务下的 wakeId→sleepId。成功只确认可运行，执行仍由 resume 驱动。已接受相同键/载荷不写新事实；冲突载荷拒绝。早到未准入请求返回 not_due、不占用键，允许到期用原键重试。过期身份返回 stale；终态不能复活。不同睡眠即使期限相同也有不同身份。键保留在任务状态，受原 1 MiB 提交上限约束，不增加清理服务或承诺无限历史。

并发写沿用 task_busy。取消与唤醒按实际提交顺序落定：尚未进入提交时取消可以阻止准入；已开始的原子写可先确认 ready，随后取消持久提交终态。wake 本身不执行下一阶段。写入成功但回执丢失时，原 holder 失败关闭，重开核对原键；不把 I/O 异常当作回滚。

## 宿主责任与恢复

宿主负责重启进程、注册相同定义/权限、查询已知任务、恢复 ready，以及用 nextWake 重建 alarm。wake 落盘后、resume 前退出会留下 ready，不出现在 nextWake 中；恢复时必须检查已知任务状态。多实例竞争仍由现有租约拒绝，不新增后台服务、分布式队列或调度工具链。

到期 resume 可以直接提交 ready 并继续阶段；它仍执行原版本/权限检查和显式迁移，已有 pendingRunId 时禁止自动重发。wake 不执行迁移。关闭空闲会话释放租约、保留睡眠；取消保留睡眠元数据供审计，但不再参与 alarm。真实进程测试覆盖睡眠提交后退出及 wake 提交后执行前退出；不声称任意业务副作用 exactly-once 或系统断电持久性。

## 兼容与回滚

公共 TypeScript 增加 sleepUntil、sleeping、TaskSleep、TaskWakeDeadline、TaskWakeResult、clock、nextWake 和 wake。TaskExecutionError 增加期限与唤醒冲突错误，仅属 TS 入口。使用穷尽 status 匹配的宿主须添加 sleeping 分支。

任务封装仍为 format=1，sleep/wakes 为可选字段；新实现读取旧无睡眠状态。旧阶段 SDK 会按封装校验拒绝新增字段与状态，包括已接受唤醒但不再 sleeping 的历史。回滚前停止 writer、备份任务目录，不删字段或伪造历史。旧 Run、Session、Protocol v2、Python/Worker 任务接口与全部门禁不改；随包 Worker 仅重新生成构建产物。

使用说明、宿主 timer 上限和验证入口见[中文指南](../guides/durable-tasks.zh-CN.md)与[英文指南](../guides/durable-tasks.en.md)。
