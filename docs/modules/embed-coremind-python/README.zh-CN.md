# Python SDK 与工具桥

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用 Python 客户端通过 stdio JSON-RPC 驱动同一 Node Runtime，并把 Python callable 注册为 Agent 工具。

## 公共接口

- `CoreMindClient`
- `AsyncCoreMindClient`
- `@client.tool`
- `resume_run`
- `inspect_run`
- `checkpoint_diff`
- `checkpoint_restore`
- `CoreMind Protocol v1`

## 错误与边界

- 协议错误映射为类型化 Python 异常
- worker 常驻复用，不为每次请求创建进程
- 工具结果跨语言保持 JSON 可序列化
- resume_run 复用 Node Runtime 的同一安全恢复判定

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
