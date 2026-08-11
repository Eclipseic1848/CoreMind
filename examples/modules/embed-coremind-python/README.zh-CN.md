# Python SDK 与工具桥示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
with CoreMindClient(config_path='coremind.yaml') as client:
    @client.tool(
        description='查询模拟订单',
        effect={'operations': ['read'], 'reversible': True},
    )
    def lookup_order(order_id: str) -> dict[str, str]:
        return {'id': order_id, 'status': 'paid'}
    result = client.run('查询 A-100')
    print(result['snapshot'])
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 删除 `effect` 再运行，确认 Python 在注册前明确拒绝；恢复后验证工具可正常调用。
6. 让测试 worker 拒绝一次注册，确认异常后没有遗留子进程或被占用的临时目录。
7. 篡改测试 Worker 的 snapshot schemaVersion 或 outcome，确认 SDK 返回 `invalid_run_snapshot`，而不是接受不一致结果。

返回 [中文指南](../../../docs/modules/embed-coremind-python/GUIDE.zh-CN.md)。
