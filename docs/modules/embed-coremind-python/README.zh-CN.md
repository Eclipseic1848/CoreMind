# Python SDK 与工具桥

状态：合同与文档已对齐 `1.0.0` 发布线；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用 Python 客户端通过 stdio JSON-RPC 驱动同一 Node Runtime，共享显式 Loop，并把 Python callable 注册为 Agent 工具。

## 公共接口

- `CoreMindClient`
- `AsyncCoreMindClient`
- `drain_notifications` / `NotificationHistory`
- `@client.tool`
- `resume_run`
- `inspect_run`
- `checkpoint_diff`
- `checkpoint_restore`
- `CoreMind Protocol v1`（`1.2.0` 默认值）
- 显式协商 `CoreMind Protocol v2`
- Protocol v2 的 `query`、`events` 与 `submit_verification` 宿主验收入口
- `result["snapshot"]` 纯 JSON 运行快照

## 错误与边界

- 协议错误映射为类型化 Python 异常
- `1.2.0` 继续支持 Protocol v1，且尚无批准的移除时间表；Protocol v2 必须显式选择。
- Python callable 仍属于 v1 工具桥；Protocol v2 只接受声明式工具定义和显式工具结果，不执行宿主 Python callable。
- v2 的 `run()` 先返回 RunHandle；`accepted` 控制回执不代表候选已应用或 Run 已成功，最终读取 `query(runId)` 的 Projection outcome。
- worker 常驻复用，不为每次请求创建进程
- 工具结果跨语言保持 JSON 可序列化
- `@client.tool` 必须提供 `effect`；Protocol 注册会校验副作用声明
- v1 `@client.tool` 自动 Schema 支持 `from __future__ import annotations` 和字符串形式的 `int`、`str`、`bool` 及既有支持范围内的容器注解；Node 侧按既有规则先转换再校验 Schema，可转换值以目标类型进入 callable，转换后仍未通过校验的参数在执行前拒绝。无法解析的前向引用会明确要求显式 `parameters`；显式 Schema 保持兼容，复杂类型仍受既有支持范围限制。
- 初始化或工具注册失败时客户端立即关闭 worker，不遗留半启动进程
- v1 的 `run`/`chat` 结果与 TypeScript 使用同一套六种终态；v2 先返回 RunHandle，再通过 Projection 查询终态
- resume_run 复用 Node Runtime 的同一安全恢复判定，可继续暂停或意外中断运行
- Python 与 TypeScript 对 `loop_state` 顺序、Loop 终态、稳定快照和 Effect Receipt 保持一致
- Protocol 对 operation、outcome、metrics、evaluation、releaseReadiness、Trace、Checkpoint、Artifact 和扩展收据执行完整嵌套校验；任意字段漂移都以 `invalid_run_snapshot` 失败关闭
- PyPI 包继续携带构建后的 Node Worker，不创建独立 Python Runtime 或 Loop

四个 `received_*` 默认完整保留；显式 `drain_notifications()` 原子取走 events、tool_calls、tool_cancellations、verification_requests 全部四桶，原 list 身份保持。必须消费或留存整个批次，取走不是服务端 ack，不清 callback 队列，也不自动回答工具/审批/验收。live 通知 sequence 与 durable events 页 nextCursor 不同；按各 runId 另存后者。见[常驻消费指南](GUIDE.zh-CN.md#常驻通知消费12-开发线)。

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [python/src/coremind](../../../python/src/coremind)
- [packages/coremind-worker/src](../../../packages/coremind-worker/src)
- [packages/coremind-protocol/src](../../../packages/coremind-protocol/src)
- [python/tests/test_client.py](../../../python/tests/test_client.py)
- [python/tests/test_node_parity.py](../../../python/tests/test_node_parity.py)
- [packages/coremind-worker/src/server.test.ts](../../../packages/coremind-worker/src/server.test.ts)
- [packages/coremind-protocol/src/protocol.test.ts](../../../packages/coremind-protocol/src/protocol.test.ts)
- [模块示例](../../../examples/modules/embed-coremind-python/README.zh-CN.md)
- [Module example](../../../examples/modules/embed-coremind-python/README.en.md)
- [Agent Skill](../../../skills/embed-coremind-python/SKILL.md)

1.2.0 源码的恢复操作身份、回调顺序、通知消费和加载信任边界见 [Python SDK 修复说明](../../../python/README.md#源码修复说明)。升级时同时更新 SDK 与 bundled Worker，并核对正式渠道的同版本制品和资格证据；旧 wheel 不因文档更新获得新行为。
