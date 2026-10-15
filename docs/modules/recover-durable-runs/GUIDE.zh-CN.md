# 持久运行与故障恢复上手指南

## 什么时候需要

当任务会写文件、运行命令、跨多轮验证，或用户希望在审批拒绝、终端关闭、网络中断后继续时，应启用本模块的恢复合同。纯一次性只读问答仍会产生 operation，但通常不需要手工 resume。

## 查看权威结果

```powershell
coremind run coremind.yaml --prompt "执行任务" --json-events
```

最后一条 `run_result.snapshot` 是权威纯 JSON 结果，统一包含 `runId`、`operation`、`outcome`、指标、评测、Trace、Checkpoint、Artifact、扩展收据和恢复判断。顶层兼容字段必须与快照一致；不要只根据自然语言总结判断成功。

## 验证关联不变量

Runtime 内部的 `checkInvariantFacts(facts, { mode })` 只读检查 Run、Session 与 Checkpoint 事实。生产默认 `off`；调试或评估使用 `eval`；发布验收使用 `gate`。Gate fixture 必须存放在受 Git 跟踪的 `packages/coremind-runtime/test-fixtures/invariant-checker/`，不能读取运行测试时生成的 `.coremind` 文件。

0.3.0 旧事实没有 TurnId，检查器按事实发生时的已知关联降级；同一 Run 在 0.3.1 Resume 后产生的新 TurnId 不能反向改变旧记录语义。

## 继续暂停或中断的运行

```powershell
coremind run coremind.yaml --resume <runId> --json-events
```

以下情况不会自动继续：配置指纹变化、operation 已终结、Effect Receipt 为 `started` 或 `unknown`、已提交副作用不属于稳定完成步骤、RunState 损坏。执行前被拒绝的工具使用 `not_started`，不会被误判为未知副作用。

Config 3 的 deferred 工具仍受同一恢复门约束：同一 Run 必须匹配原配置指纹，不能改配置后借旧选择集合扩权。目录快照、成功搜索与声明代次保存在私有追加事实中；公开 `context_prefix` 和 `provider_request` 只引用安全摘要。新 Run 根据当前配置重新建立声明，旧 Session、父级或上次 Run 的激活不构成授权。没有工具发现事实的旧 Run 沿原路径恢复，不推测历史工具集合。

同一 Run 内还须区分 execution。质量重试是新的 execution，即使 Agent 和 Step 相同也不复用旧激活。只有最后的权威暂停记录精确绑定待续 execution，才恢复该执行的目录与选择代次；已经成功完成的执行不成为待续项。崩溃没有精确绑定时，若原准入允许恢复，则从新的 deferred 声明开始，不猜最近同 Agent/Step 的旧状态。该私有绑定不会出现在公开投影或 Worker 事件中；它也不证明完整会话消息已经恢复。

从冷启动 Worker 读取同一批 Facts 并重投影，不等于已获准继续执行。继续执行仍须通过原输入、步骤边界、Effect Receipt 与所有权检查；搜索成功也不免除后续工具审批。

## 旧 Session

恢复旧文件时框架会自动创建 `.v3.backup`。受支持的消息、模型变更、工具集变更、压缩、分支摘要、标签和名称会迁移。无法无损表达的旧条目会返回明确错误，原文件保留；按 [SOP](SOP.zh-CN.md) 人工选择保留旧版本或导出有效上下文。

## 新手最容易犯的错误

- 把 `paused` 当作失败后自动重试信号。
- 看到文件已变化，就假设远端副作用也成功。
- 手工删除锁，却没有先确认是否仍有 writer。
- 只备份新格式文件，遗漏自动生成的旧文件备份。
- 终端关闭后用新 prompt 重跑，导致不可幂等工具重复执行。
- 把本机 `.coremind` 运行产物当作可复现的 Gate fixture。

运行 [模块示例](../../../examples/modules/recover-durable-runs/README.zh-CN.md) 后，再把恢复策略接入具体业务。
