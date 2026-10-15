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

## HTTP MCP 资源验证

采用[HTTP 配置片段](../../../docs/guide/02-configuration.md#mcp受控-http-与精确资源授权)，将 `https://mcp.example.com/mcp` 替换为自己审核过的固定目标，将 `fixture://first` 替换为服务实际提供且允许当前 Agent 读取的完整 URI。环境变量 `MCP_AUTHORIZATION` 提供完整的 `Bearer <服务令牌>` Header 值，不在 YAML 中写令牌；本片段不是可直接调用的公共演示服务。

本地 HTTP 夹具才使用 `http://127.0.0.1:8765/mcp` 与 `allowedAddresses: ['127.0.0.1']`。公网 HTTPS 缺省只允许核验后的公网地址；非空允许集合约束该 endpoint 全部解析地址，不是追加例外。URL 不含 query、userinfo 或 fragment，所有重定向拒绝，环境代理忽略，静态 `doctor` 不联网。

1. 仅授权资源且不选择或继承 MCP 工具，确认首次模型请求前服务请求为零；调用 read 后才握手。只授权工具的反例不得列出资源。
2. 调用 list、templates 和精确 read。缺省/空 `mcpResources` 不继承；猜另一个 URI、模板展开越界、响应夹带未授权 URI 均须拒绝，不读取本机 `file:`，不跟随链接，不执行 HTML，不支持 blob。
3. 在 `network: allow` 下确认网络元操作按配置批准，即使 `mode: ask` 也不额外询问；另测 `network: ask` 的原审批与 deny 零发送。保留真实业务 `external` 和工作区硬门，不通过改声明获得权限。
4. 用仓库 HTTP 回归验证分页、8 MiB body/64 MiB owner、32 页/256 条、30 秒总期限与最多 3 GET/30 秒恢复。取消资源请求时其他合法调用应继续；写后断线不得重发业务 POST。Run 关闭回收本地 body/socket/dispatcher，远端 session 依赖服务租约，不发送 DELETE。
5. 检查成功、缺失凭据、401/403 和已发送后取消的 TS、CLI、Python 同步/异步路径。凭据不进入模型、Facts、Artifact 或 Worker JSON；401/403 不自动 OAuth/刷新。旧 Worker 明确拒绝，Child 不继承任何 MCP/资源/凭据。

这些步骤定义验收方法，不声明全套测试、安装制品或真实外部服务互通已经通过；分别保存实际执行证据。

返回 [中文指南](../../../docs/modules/build-tools/GUIDE.zh-CN.md)。
