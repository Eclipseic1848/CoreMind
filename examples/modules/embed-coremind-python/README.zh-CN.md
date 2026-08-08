# Python SDK 与工具桥示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
with CoreMindClient(config_path='coremind.yaml') as client:
    @client.tool(description='查询模拟订单')
    def lookup_order(order_id: str) -> dict[str, str]:
        return {'id': order_id, 'status': 'paid'}
    result = client.run('查询 A-100')
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。

返回 [中文指南](../../../docs/modules/embed-coremind-python/GUIDE.zh-CN.md)。
