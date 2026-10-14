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

## 运行中控制（1.1 开发线）

Python 继续使用既有 Protocol v2 `control`、`events` 和 `query`，不新增便利 API 或协议版本。显式选择 `protocol_version="2.0"`；默认执行随包 Worker，不需要从源码目录寻找 Worker。以下操作面向已就绪的活动 Run，`run_id` 取自该 RunHandle：

```python
receipt = client.control({
    'schemaVersion': 1,
    'runId': run_id,
    'controlId': 'review-tests-1',
    'type': 'steering',
    'message': '先核对测试结果',
})
page = client.events(run_id, after_sequence=0)
```

`type` 可为 `steering` 或 `follow_up`：后者等 Agent 自然停止后继续同一 Run。AsyncCoreMindClient 的对应方法使用 `await`，合同相同。`events` 每次必须显式传 `after_sequence`；保存已读 sequence 后递增补读，不把一次空页当作终态，最终用事件或 `query` 核对 outcome。

保留 controlId 重试，相同内容为 duplicate，不同内容为 conflict；另外三态为 accepted、applied、rejected。accepted 是持久接收，applied 是应用事实提交后交付 Agent 队列，都不是模型已消费。按 inputId 区分独立的 `input_receipt/input_claimed/input_completed/input_discarded`。错误 Run、未就绪或已封口会拒绝；控制不批准工具、不改变权限或预算，也不新开并发 Run。

冷恢复可继续 accepted 控制；applied 但未确认消费者不自动重投，只明确 discarded，不能宣称消除了提交与内存交付的崩溃窗口。暂停原输入仍可恢复，普通原输入已 discarded 时仍不能恢复；控制收据不代替普通 Session 正文或完整对话重建。默认 v1 客户端与工具桥保持原合同。真实随包路径回归见 [test_runtime_controls.py](../../../python/tests/test_runtime_controls.py)。

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
10. 对 v2 输入控制分别验证 sync/async、重复/冲突、取消丢弃与下一 Run 无队列泄漏，保留真实请求及输入事件证据。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
