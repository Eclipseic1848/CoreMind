# Checkpoint、Diff 与恢复

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

在 edit/write 前保存文件快照，提供 diff 和显式恢复；无法保证的副作用明确标记不可逆。

## 公共接口

- `CheckpointManager`
- `inspectCheckpoint`
- `restoreCheckpoint`

## 错误与边界

- checkpoint_too_large：超出快照上限时阻止修改
- checkpoint_not_reversible：拒绝伪恢复
- checkpoint_corrupt：记录无效
- checkpoint_conflict：工具完成后文件又被人工或并发修改，拒绝覆盖新内容

`edit`/`write` 在执行前保存原始快照，执行后记录预期文件指纹。恢复只在当前文件仍等于该预期状态时进行；这是一条乐观并发保护，不是任意副作用事务。

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/checkpoint.ts](../../../packages/coremind-runtime/src/checkpoint.ts)
- [packages/coremind-runtime/src/checkpoint.test.ts](../../../packages/coremind-runtime/src/checkpoint.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/manage-checkpoints/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-checkpoints/README.en.md)
- [Agent Skill](../../../skills/manage-checkpoints/SKILL.md)
