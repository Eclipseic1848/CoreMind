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
5. 另用声明了 `pathFields` 或 `urlFields` 的测试工具传入工作区外的 `../secret.txt` 或禁止访问的 URL，确认工作区/网络策略在执行前拒绝；上面的 `lookup_order` 只有 `id` 参数，不承担路径或 URL 检查。
6. 把工具名临时改为 `read`，确认定义或注册在执行前被拒绝；随后恢复业务专用名称。
7. 运行 ProcessRunner、GitAdapter 与统一 Diff 的测试，确认超时、中止、输出上限、只读 Git 和超大文件均失败关闭。

## 本地 MCP 验证

使用[完整配置](../../../docs/guide/02-configuration.md#mcp按-agent-选择本地工具)替换成本机已经审核的 stdio 程序。先运行 `coremind doctor coremind.yaml`，确认自检没有启动服务，再通过 `coremind run coremind.yaml --prompt "调用已批准的工具"` 分别审批连接、目录和业务动作。检查三次独立 Call/EffectReceipt、真实原名参数与终态后进程退出。

安全默认配置应在启动前拒绝；显式 trusted_host 示例需要开放工作区和网络，所以既有 `coremind check` 应报告工作区安全门失败，不能当成受限项目发布合格。先在仓库的真实 MCP 回归中验证，再接自己的程序；仓库离线回归不需要真实模型凭据。

返回 [中文指南](../../../docs/modules/build-tools/GUIDE.zh-CN.md)。
