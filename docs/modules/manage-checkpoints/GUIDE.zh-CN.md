# Checkpoint、Diff 与恢复上手指南

## 什么时候使用

在 edit/write 前保存文件快照，提供 diff 和显式恢复；无法保证的副作用明确标记不可逆。

## 最小示例

```text
/checkpoints
/diff CHECKPOINT_ID
/restore CHECKPOINT_ID
```

推荐顺序是 `/checkpoints` → `/diff ID` → 人工确认 → `/restore ID`。如果 `/restore` 返回 `checkpoint_conflict`，说明文件在工具完成后又发生变化：不要重试覆盖；先复制当前文件，人工比较三份内容，再决定如何合并。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/manage-checkpoints/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 工具写入后手工修改同一文件，再执行 `/restore`；必须拒绝且保留手工修改。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
