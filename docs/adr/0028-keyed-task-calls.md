# ADR 0028：稳定键调用与原 Run 的确定性恢复

- 状态：1.4 开发线，须完成原验收与合并后才具有发布资格。
- 关联：[#365](https://github.com/Eclipseic1848/CoreMind/issues/365)，延续 ADR 0025–0027。

## 决定

新增 TaskPhaseContext.runCalls 与 TaskCallContext.executeTool。一个阶段最多一个 Run，内部所有工具及 delegate 复用 Runtime Harness、ToolExecutionEngine、ChildRun Coordinator、RunBudget 和原超时。精确工具 Driver 不调用父模型；不接收宿主提供的裸执行器，不增加第二个 Runtime。

TaskCommit 保存带 phase/version/RunId 的调用组：规范化参数、工具、权限/能力身份、顺序、stepId、状态及结果。key 在当前组内唯一；重复连接在飞调用或读回已提交结果。不同键串行，不接受并行启动、签名或历史顺序分歧。调用分歧保存审计，不能被 handler 吞错后作为成功提交。

RunState critical step_output 是工具结果的执行事实；TaskCommit 是阶段调用结果的权威账本及阶段提交的唯一所有者。顺序为 intent、受治理执行、原回执/生命周期收敛、Run 整步结果、任务账本、handler 返回。不宣称两个文件跨域原子提交；崩溃窗口通过原 Run 的已完成步骤协调。Run 成功后的重入只允许旧键；未完成 Run 仍通过原恢复门，未知效果拒绝，幂等新 Call/attempt 保持旧 receipt 关联与不可变性。任务 Run 的 start 标记限制其只能由相同任务作用域恢复。

## 边界和代价

原 context.run 合同不变。runCalls 不替代 workflow/loop；跨语言入口留给 #367。预算按阶段 Run 计量，不承诺全任务累计预算。模型型子任务须使用现有固定目标 delegate，不允许自建绕过权限的子执行器。参数与结果遵守原凭据识别/JSON/大小边界；历史受 1 MiB TaskCommit 上限约束。任意可信宿主代码不受重放或强制中止保证，闭包/依赖/外部能力变化必须由宿主提升版本或 authorityVersion。

失败与取消结果保留可查询标记，完成/取消父任务不复活。没有自动清理；I/O 确认未知时 holder 失效，须保全并重开核查，不假设回滚。旧任务可读，旧 SDK 不支持新 callGroups/Run 标记；回滚必须停止 writer 并备份两个事实域，不得用旧 SDK 单独恢复新任务 Run。

## 验证

稳定键复用、在飞连接与冲突、父任务/阶段/版本身份、顺序分歧、能力变化、权限/预算/取消、真实 ChildRun 及结果投影故障。真实子进程分别在 intent、效果、Run 结果和任务结果提交窗口退出；未知效果不重放，符合原幂等证明的尝试使用新 Call 并保留绑定。既有 Windows/Linux、安全、覆盖率、超时门禁不变。API 与双语指南、模块、SOP、Skill、示例及 CHANGELOG 同步。
