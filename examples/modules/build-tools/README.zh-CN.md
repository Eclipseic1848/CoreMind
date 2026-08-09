# 工具与业务能力示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  effect: { operations: ['read'], reversible: true },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 把参数改成嵌套的 `../secret.txt` 或 URL，并确认工作区/网络策略在执行前拒绝。
6. 把工具名临时改为 `read`，确认定义或注册在执行前被拒绝；随后恢复业务专用名称。
7. 运行 ProcessRunner、GitAdapter 与统一 Diff 的测试，确认超时、中止、输出上限、只读 Git 和超大文件均失败关闭。

返回 [中文指南](../../../docs/modules/build-tools/GUIDE.zh-CN.md)。
