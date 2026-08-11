# 持久运行与故障恢复上手指南

## 什么时候需要

当任务会写文件、运行命令、跨多轮验证，或用户希望在审批拒绝、终端关闭、网络中断后继续时，应启用本模块的恢复合同。纯一次性只读问答仍会产生 operation，但通常不需要手工 resume。

## 查看权威结果

```powershell
coremind run coremind.yaml --prompt "执行任务" --json-events
```

最后一条 `run_result.snapshot` 是权威纯 JSON 结果，统一包含 `runId`、`operation`、`outcome`、指标、评测、Trace、Checkpoint、Artifact、扩展收据和恢复判断。顶层兼容字段必须与快照一致；不要只根据自然语言总结判断成功。

## 继续暂停或中断的运行

```powershell
coremind run coremind.yaml --resume <runId> --json-events
```

以下情况不会自动继续：配置指纹变化、operation 已终结、Effect Receipt 为 unknown、已提交副作用不属于稳定完成步骤、RunState 损坏。

## 旧 Session

恢复旧文件时框架会自动创建 `.v3.backup`。受支持的消息、模型变更、工具集变更、压缩、分支摘要、标签和名称会迁移。无法无损表达的旧条目会返回明确错误，原文件保留；按 [SOP](SOP.zh-CN.md) 人工选择保留旧版本或导出有效上下文。

## 新手最容易犯的错误

- 把 `paused` 当作失败后自动重试信号。
- 看到文件已变化，就假设远端副作用也成功。
- 手工删除锁，却没有先确认是否仍有 writer。
- 只备份新格式文件，遗漏自动生成的旧文件备份。
- 终端关闭后用新 prompt 重跑，导致不可幂等工具重复执行。

运行 [模块示例](../../../examples/modules/recover-durable-runs/README.zh-CN.md) 后，再把恢复策略接入具体业务。
