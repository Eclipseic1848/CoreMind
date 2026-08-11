# Python SDK 与工具桥上手指南

## 什么时候使用

用 Python 客户端通过 stdio JSON-RPC 驱动同一 Node Runtime，并把 Python callable 注册为 Agent 工具。

## 最小示例

```text
with CoreMindClient(config_path='coremind.yaml') as client:
    @client.tool(
        description='查询模拟订单',
        effect={'operations': ['read'], 'reversible': True},
    )
    def lookup_order(order_id: str) -> dict[str, str]:
        return {'id': order_id, 'status': 'paid'}
    result = client.run('查询 A-100')
    print(result['snapshot']['operation'], result['snapshot']['artifacts'])
    if result['outcome']['status'] != 'succeeded':
        raise RuntimeError(result['outcome']['finishReason'])
```

`effect` 会随 `register_tool` 发给共享 Runtime。非标准路径或 URL 字段可填写 `pathFields`、`urlFields`。运行终态在 `result['outcome']`，协议、启动与调用方错误才使用 Python 异常。

如果 initialize 或任一工具注册失败，客户端会先关闭已启动的 worker，再把异常返回给调用方。仍建议使用上下文管理器或 `finally` 处理正常生命周期。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/embed-coremind-python/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 验证 Python 与 TypeScript 对六种终态、工具副作用和审批事件的字段完全一致。
6. 注入一次注册失败，确认 `client.pid` 被清空且临时目录可以删除。
7. 使用显式 Loop 时对比 Python 与 TypeScript 的 `loop_state` 顺序；暂停后调用 `resume_run`，确认 committed 副作用未重复。
8. 校验 `result['snapshot']` 与顶层 runId、outcome、operation、metrics、trace 一致；收到 `invalid_run_snapshot` 时停止使用该 Worker。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
