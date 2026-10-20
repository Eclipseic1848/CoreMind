# Python SDK 与工具桥上手指南

## 什么时候使用

用 Python 客户端通过 stdio JSON-RPC 驱动同一 Node Runtime。默认 Protocol v1 可把 Python callable 注册为 Agent 工具；需要宿主验收时显式选择 Protocol v2。

## 最小示例

```text
from __future__ import annotations

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

v2 `run()` 已返回 RunHandle 后，若后台 Runtime 初始化失败，应通过 `query(runId)` 或 `events` 读取同一 Run 的持久失败结果。已登记错误沿用共享分类的稳定错误码、对应终态与安全消息；未知异常以 `unclassified_error` 暂停，须人工审计后决定后续处理。它不同于 SDK `initialize` 调用本身抛错，不应把所有启动错误归为 `agent_failed`，也不应输出凭据或原始堆栈。

在 v1 中，`effect` 会随 `register_tool` 发给共享 Runtime。非标准路径或 URL 字段可填写 `pathFields`、`urlFields`；终态在 `result['outcome']`，协议、启动与调用方错误才使用 Python 异常。

省略 `parameters` 时，`@client.tool` 从参数注解生成 Schema，支持 future 或字符串形式的 `int`、`str`、`bool` 和既有支持的容器注解（如 `list[int]`）。Node 侧先按既有规则转换再校验；例如 `int` 参数收到字符串 `'5'` 时，转换为整数 `5` 后进入 callable，转换后仍未通过 Schema 校验的参数在执行前拒绝。前向引用无法解析时会明确报错并要求显式 `parameters`；复杂 typing 仍按既有支持范围处理，需要精确约束时提供显式 Schema，既有显式 `parameters` 用法不变。

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

`type` 可为 `steering` 或 `follow_up`：后者等 Agent 自然停止后继续同一 Run。AsyncCoreMindClient 的对应方法使用 `await`，合同相同。`events` 每次必须显式传 `after_sequence`；每个 Run 分别保存页返回的 `nextCursor`，处理成功后以它补读，不用 live 通知的 sequence 计算游标，也不把一次空页当作终态，最终用事件或 `query` 核对 outcome。

保留 controlId 重试，相同内容为 duplicate，不同内容为 conflict；另外三态为 accepted、applied、rejected。accepted 是持久接收，applied 是应用事实提交后交付 Agent 队列，都不是模型已消费。按 inputId 区分独立的 `input_receipt/input_claimed/input_completed/input_discarded`。错误 Run、未就绪或已封口会拒绝；控制不批准工具、不改变权限或预算，也不新开并发 Run。

冷恢复可继续 accepted 控制；applied 但未确认消费者不自动重投，只明确 discarded，不能宣称消除了提交与内存交付的崩溃窗口。暂停原输入仍可恢复，普通原输入已 discarded 时仍不能恢复；控制收据不代替普通 Session 正文或完整对话重建。默认 v1 客户端与工具桥保持原合同。真实随包路径回归见 [test_runtime_controls.py](../../../python/tests/test_runtime_controls.py)。

## MCP 显式登录（1.1 开发线）

交互认证需要新 Worker 协商 `mcpAuthentication`，显式选择 v2 并提供专用 handler：

```python
from coremind import CoreMindClient

def show_authorization(request):
    show_temporary_link(request['authorizationUrl'])

with CoreMindClient(config, protocol_version='2.0',
                    mcp_auth_handler=show_authorization) as client:
    client.mcp_login('remote', transaction_id='login-1')
    handle = client.run('读取已授权资源')
    # 按 handle 的 runId 补读 events/query，直到真实终态。
    client.mcp_logout('remote')
```

`config` 和临时链接 UI 由宿主提供；先等待 Run 终态再 logout。reader 线程只校验并投递有界队列，sync handler 在发起登录的线程执行，可通过另一线程的 `mcp_cancel_auth('login-1')` 取消并等待 Node 收尾。handler 抛错同样取消原事务。handler 应有界返回，不应无限阻塞。

`AsyncCoreMindClient` 使用同样参数；对 `mcp_login/mcp_logout/mcp_cancel_auth` 使用 await。async handler 在原事件循环执行，取消登录 Task 会取消该 handler，向 Node 发送原事务 cancel 并等待收尾，不仅停止 Python 等待。不要复用活动事务 ID，取消必须属于自己的登录。

默认 v1 或缺少 handler 时，在认证请求前明确返回 `protocol_capability_missing` 或 `mcp_auth_required`。新 SDK 遇到旧 v2 Worker 仍执行精确 schema 指纹检查；不能降级伪报交互成功。授权请求仅进入专用 handler，不进入 `received_events`；Token、callback code 与 verifier 留在 Node。Python 不接收 TokenStore，不默认写明文文件。同一客户端跨 Run 复用内存凭据，关闭后需重登；远端撤销不在本地 logout 合同内。真实外部服务互通未验证，完整边界见[配置指南](../../guide/02-configuration.md)。

## 工具发现与 Worker 兼容（1.1 开发线）

使用[按需工具配置](../../guide/02-configuration.md#按需曝光工具11-开发线)时须显式写 Config 3；旧 Config 2 省略 `exposure` 的行为保持不变。Python 仍调用原有 `run/chat`，由同一 Node Runtime 进行搜索与声明安装，不增加第二个配置进程或 Python 工具目录。

默认 v1 的首次 initialize 保持旧包形状，不附加 `capabilities`。只有收到 `protocol_capability_missing` 且 details 精确为 `{schemaVersion: 1, requiredCapabilities: ['toolDiscovery'], retryInitialize: true}`，SDK 才在同一进程最多重发一次并仅附加 `toolDiscovery`；普通错误和畸形挑战不重试，成功回执也必须确认该能力。v2 在首包声明能力并校验精确 schema 指纹与能力回执，失败不降级。旧 Worker 必须在任何 Run 前拒绝 Config 3；旧 SDK 不认识能力挑战时会明确失败。

搜索命中不代表工具已获执行批准。下一请求完成持久安装后仍执行原审批与 deny；新 Run 重新建立声明，同一 Run 恢复仍受配置指纹约束。`context_prefix` 和 `provider_request` 的可选 `toolDiscovery` 只含五字段安全摘要，Python 对出现的摘要做封闭校验；完整目录和参数 schema 不经公开事件传输。本节说明协议与使用合同，不代表外部服务互通或本版本发布资格已通过。

`resume_run` 只有在最后权威暂停记录精确绑定待续 execution 时，才沿用该执行的已安装工具集合。质量重试建立新 execution；崩溃没有该绑定时，在原恢复门准入后从新的 deferred 声明开始，不借同 Run/Agent/Step 的旧激活。此绑定由 Node 的私有事实管理，不增加 Python 目录、公开 owners 字段或消息恢复承诺；原配置指纹、输入、审批和副作用检查仍适用。

## 常驻通知消费（1.2 开发线）

默认不调用 drain 时，`received_events`、`received_tool_calls`、`received_tool_cancellations`、`received_verification_requests` 完整保留。新方法一次取走当前全客户端四桶，清空原 list 而不替换对象；每桶保序，元素是原 Mapping 的浅引用。批次可能含多个 runId，不保证跨桶总交错顺序；外部直接并发修改 list 不在 SDK 线程安全保证内。

以下函数先留存**整个** batch；`retained` 由宿主持有，完整处理或持久保存四桶后再释放，不能让该宿主容器无限累积。方法本身不启动 Worker、不发 RPC，也可读取 close 前留下的历史。

```python
from coremind import AsyncCoreMindClient, CoreMindClient, NotificationHistory

def collect(client: CoreMindClient, retained: list[NotificationHistory]) -> None:
    retained.append(client.drain_notifications())

async def collect_async(client: AsyncCoreMindClient,
                        retained: list[NotificationHistory]) -> None:
    retained.append(await client.drain_notifications())
```

宿主分别处理 `batch['events']`、`batch['tool_calls']`、`batch['tool_cancellations']` 和 `batch['verification_requests']`。按 runId、callId、registrationId 关联工具和取消；仍通过 `submit_tool_result` / `submit_verification` 等原接口显式回应。取走不是服务端 ack，不自动批准/执行，不代表业务处理或 callback 已完成。回调队列、已执行的 handler、过载错误和 v1 callable 不受清表影响；handler 可重入 drain。MCP 授权 URL/回执走专用 handler，不混入批次。

async drain 故意在调用 Task 内直接执行本地短锁复制，不开 `to_thread` 消费线程，从而没有后台已清表、等待 Task 却取消而拿不到批次的中间窗口。复制仍是 O(N)，会暂占调用线程/loop；没有自动硬容量限制，应规律消费。默认不调用时旧完整保留行为不变。

durable 补读是另一个面：显式 v2 的 `events()` 不读取或补回四个 live list。每个 Run 保存自己的 **页返回 nextCursor**，成功处理页后再推进，绝不把 live 通知 sequence 当作该 cursor，也不加一猜值。下面 `consume_page` 是宿主处理或可靠保存完整页的同步函数；抛错就不推进：

```python
from collections.abc import Callable, Mapping
from typing import Any

def catch_up_page(client: CoreMindClient, run_id: str,
                  cursors: dict[str, int],
                  consume_page: Callable[[Mapping[str, Any]], None]) -> bool:
    page = client.events(run_id, after_sequence=cursors.get(run_id, 0), limit=100)
    consume_page(page)
    cursors[run_id] = page['nextCursor']
    return page['hasMore']
```

Async 对 `events` 使用 await，仍在处理成功后保存该 Run 的 nextCursor。`hasMore=True` 继续翻页；运行中暂时 False/空页不等于终态，需事件或 query 核对。`cursor_expired` 沿原 `ProtocolError.details` 的 recovery/projection/newCursor 处理，不擅自重置或借另一 Run 的 cursor。drain 不改变这些游标。durable events 只提供事实/事件/投影恢复依据，不保证原样重放专用 tool_call、tool_cancel、verification_request，不能代替尚待宿主处理的四桶。v1 没有该 v2 events 补读 API，保留原 inspect_run/snapshot 能力。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/embed-coremind-python/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对 v1 结果验证 Python 与 TypeScript 的六种终态、工具副作用和审批事件字段一致；v2 通过 `query(runId)` 核对 Projection outcome。
6. 仅对 v1 工具桥注入注册失败，确认 `client.pid` 被清空且临时目录可以删除。
7. 使用显式 Loop 时对比 Python 与 TypeScript 的 `loop_state` 顺序；暂停后调用 `resume_run`，确认 committed 副作用未重复。
8. 对 v1 校验 `result['snapshot']` 与顶层 runId、outcome、operation、metrics、trace 一致；收到 `invalid_run_snapshot` 时停止使用该 Worker。
9. 对 v2 宿主验收，按每个 RunId 保存的 events 页 `nextCursor` 补读，拒绝候选后确认同一 Run 修复，并区分控制回执与最终 outcome。
10. 对 v2 输入控制分别验证 sync/async、重复/冲突、取消丢弃与下一 Run 无队列泄漏，保留真实请求及输入事件证据。
11. 对 v1 自动 Schema 覆盖 future/字符串 `int`、`str`、`bool` 与已有容器注解，确认 Node 保留既有类型转换，可转换值以目标类型进入 callable，转换后仍未通过 Schema 的参数在执行前拒绝；无法解析的前向引用要求显式 `parameters`，原显式 Schema 仍可使用。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。

## Worker 输出交付限制

随包 Worker 的 stdout 队列与在飞消息合计最多 **64 MiB 已编码 UTF-8、1024 条**，单条最多 64 MiB；关键 RPC 响应、审批/工具/认证通知和控制回执不能因队列已满而静默丢弃。其他既有 best-effort `event` 通知在总预算不足时可以丢弃；v2 宿主可用持久 `events` 补读，按每个 Run 的实际分页 `nextCursor` 推进。live 通知的 `sequence` 是独立计数，不能当作持久游标；v1 没有同等的持久补读保证。单条本身超限仍使传输失败。

普通 write/drain 等待不暂停输入，因此审批、cancel 和 tool_result 仍可进入。硬溢出、断管或写入错误触发一次 shutdown：拒绝新输入，取消活动 Run、待工具和待审批，并等待原有静止检查。EOF 同样先等待 shutdown，再在 **10 秒**内等待已接收 RPC 的最终响应和真实输出 flush；未达到静止不能算成功。stdout 已不可用时不保证还能发送错误响应或 cancel ACK；Worker 以非 0 状态和 stderr 的 `output_delivery_failed` 诊断报告交付失败，Python 可能按既有合同抛出 `WorkerExitedError`，不能假设一定收到该码的 JSON-RPC 错误。

这是传输层有界失败合同，Runtime 的同步事件回调没有变成异步背压。限制不包括 JSON 编码瞬时内存、上游响应生成及接收端资源。传输层不改写既有持久事实、不放宽权限；Runtime 仍按自身取消和收尾规则记录结果，不把交付故障伪造成业务完成，也不自动重试潜在副作用。

上述10秒限制交付等待，不保证强制终止物理流或不合作的 JavaScript。逻辑 close 有界返回；尚未返回的自有 write 仅保留一个 error 护栏及其 close 清理监听，直到该回调或流 close 收敛。超时失败不等于全部操作已静止；未确认收尾时不能据此释放或复用相关环境。
