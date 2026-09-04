# Host verification：同 Run 宿主验收

[English](README.en.md)

这是当前开发分支新增能力，不是已公开的 0.7.1 包所提供的接口。使用本分支构建产物，不安装旧公开包后期待存在新接口。

在仓库根目录构建后运行：

```sh
npm run build
node examples/host-verification/demo.mjs
```

示例只调用 localhost 模型替身，依次生成 draft/revised；宿主拒绝初稿，CoreMind 原生 Loop 修正，宿主接受后同一 Run 才成功。模型请求共两次，没有额外的验证模型，也没有宿主自建修正循环。

`onVerification` 仅通知，返回 true/PASS 不会放行。宿主需通过 `acceptControl` 回复与请求身份、候选摘要一致的决定；未知、超时和 paused 不等于验收通过。

生产接入时，把示例字符串判断替换为宿主自己的独立验证。来源、Owner、Grant、部分结果和正式 Delivery 留在宿主；CoreMind 只管理通用执行合同。候选文本 SHA 不自动证明外部制品或业务对象已核验。

## Python 宿主接入

使用同一开发提交构建的 Python 包和 bundled Worker，并以 `protocol_version="2.0"` 创建 `CoreMindClient`。配置中启用 `loop.verify.mode="host"`；execute、repair、maxIterations、maxRepairs 仍由原 Loop 配置控制。

`client.run(...)` 返回 RunHandle 后，由宿主事件处理逻辑读取 `client.received_verification_requests`。SDK 已校验通知结构与文本摘要。以下片段处理一个请求；`accepted` 与 `feedback` 必须来自宿主独立验证，不来自模型自报 PASS：

```python
def reply_to_candidate(client, request, *, accepted, feedback, control_id):
    return client.submit_verification(
        request["runId"],
        request["requestId"],
        request["candidateSha256"],
        decision="accept" if accepted else "reject",
        feedback=feedback,
        control_id=control_id,
    )
```

宿主必须核对请求属于自己持有的 Run 和业务对象；每个决定保存稳定的 control_id，网络结果未知时使用同 ID、同内容重试。拒绝反馈必须非空且不能含密钥。处理过的通知应记录身份，不能反复批准整个列表。异步客户端通过 `sync_client.received_verification_requests` 读取通知，使用 `await client.submit_verification(...)` 回复。

`applied` 表示决定已持久应用，不代表业务交付完成；随后用 `client.query(run_id)` 核对 projection 的 outcome。`accepted` 仅表示收件，`duplicate` 不能单独证明 Run 成功。paused/未知不得交付；重启后使用原配置、存储目录及 `resume_run(run_id)`，重新收到原请求后再处理。宿主不另起 repair Run。

可执行的完整 Python 接入验证见 [test_host_verification.py](../../python/tests/test_host_verification.py)，覆盖拒绝修正、取消和客户端重启；只访问 localhost 替身。

协议与恢复规则见 [宿主验收合同](../../docs/spec/0.7.x/03-host-verification.md)。不为本示例发布版本或调用真实 Provider。
