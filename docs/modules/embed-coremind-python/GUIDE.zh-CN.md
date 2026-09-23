# Python SDK 与工具桥上手指南

## 什么时候使用

用 Python 客户端通过 stdio JSON-RPC 驱动同一 Node Runtime。默认 Protocol v1 可把 Python callable 注册为 Agent 工具；需要宿主验收时显式选择 Protocol v2。

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

以上是默认 Protocol v1 示例。`0.8.0` 的宿主验收应使用 `CoreMindClient(..., protocol_version="2.0")`：`run()` 先返回 RunHandle，宿主核对 `received_verification_requests` 后用 `submit_verification` 提交决定，再用 `query(runId)` 读取最终 Projection outcome。v2 不执行 `@client.tool` Python callable；完整流程见[宿主验收示例](../../../examples/host-verification/README.md)。

在 v1 中，`effect` 会随 `register_tool` 发给共享 Runtime。非标准路径或 URL 字段可填写 `pathFields`、`urlFields`；终态在 `result['outcome']`，协议、启动与调用方错误才使用 Python 异常。

如果 initialize 或任一工具注册失败，客户端会先关闭已启动的 worker，再把异常返回给调用方。仍建议使用上下文管理器或 `finally` 处理正常生命周期。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/embed-coremind-python/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对 v1 结果验证 Python 与 TypeScript 的六种终态、工具副作用和审批事件字段一致；v2 通过 `query(runId)` 核对 Projection outcome。
6. 仅对 v1 工具桥注入注册失败，确认 `client.pid` 被清空且临时目录可以删除。
7. 使用显式 Loop 时对比 Python 与 TypeScript 的 `loop_state` 顺序；暂停后调用 `resume_run`，确认 committed 副作用未重复。
8. 对 v1 校验 `result['snapshot']` 与顶层 runId、outcome、operation、metrics、trace 一致；收到 `invalid_run_snapshot` 时停止使用该 Worker。
9. 对 v2 宿主验收，按 RunId 与 sequence 补读 `events`，拒绝候选后确认同一 Run 修复，并区分控制回执与最终 outcome。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
