# Checkpoint、Diff 与恢复示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
/checkpoints
/diff CHECKPOINT_ID
/restore CHECKPOINT_ID
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 让工具写入文件后手工再改一次，执行 `/restore ID`；预期返回 `checkpoint_conflict`，且手工内容保持不变。

返回 [中文指南](../../../docs/modules/manage-checkpoints/GUIDE.zh-CN.md)。
