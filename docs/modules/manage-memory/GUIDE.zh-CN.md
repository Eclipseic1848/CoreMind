# 接入长期记忆

## 从空白项目只接入记忆

按[示例](../../../examples/modules/manage-memory/README.zh-CN.md)在宿主安装 0.1.0 wheel 并启动 `coremind-memory-mcp`。普通 MCP 客户端可以直接连接。使用 CoreMind 时，在业务项目运行 `npm install --save-exact coremind-cli@2.0.0 coremind-ai@2.0.0` 安装 CLI 和 TypeScript SDK。使用 Python 的项目安装 `coremind-ai==2.0.0`，由 wheel 自动选择内置 Worker。下面的 `coremind.yaml` 只注册一个工具。示例中的业务模型可换为宿主已配置的模型。

以上公共安装命令用于复验 2.0.0 客户端兼容性。测试 2.1.0 候选时，改为[安装本地候选 CLI 和 SDK](../../migrations/2.0-to-2.1.zh-CN.md)，沿用同一份网关配置。

```yaml
schemaVersion: 3
name: memory-client
provider: { id: deepseek, model: deepseek-flash, apiKeyEnv: DEEPSEEK_API_KEY }
defaultAgent: main
mcp:
  servers:
    memory:
      transport: streamable-http
      url: http://127.0.0.1:8769/mcp
      allowedAddresses: ["127.0.0.1"]
      headers: { Authorization: { env: COREMIND_MEMORY_AUTHORIZATION } }
agents:
  main:
    systemPrompt: 使用 recall_memory 查询已确认事实，回答时注明来源和版本。
    tools:
      - mcp: { server: memory, tool: recall_memory }
        effect: { operations: [network], reversible: true }
        capability: { effect: network, replay: safe, concurrency: run_serial, checkpoint: none, durability: critical }
permissions: { mode: ask, network: allow, workspaceOnly: true }
runtime: { maxTurns: 3, maxToolCalls: 4, maxRetries: 0 }
quality: { profile: development }
```

在业务终端注入已配置的模型凭据，把 `COREMIND_MEMORY_AUTHORIZATION` 设为宿主发放的 `Bearer …` 读令牌，再运行 `npx --no-install coremind check coremind.yaml`。空白项目使用开发级检查，尚缺测试等项目材料时会报告警告。记忆库绑定文件、管理令牌、Hindsight API 密钥、数据库及回执由服务环境保管。网关监听回环地址。跨机器调用需要宿主提供经过访问控制的服务入口，并配置对应 URL 和地址白名单。

## 确定谁可以读写

1. 在宿主侧确定项目、主体和 Agent，指定仅本会话分支可见的记忆或经授权跨会话共享的记忆。为新会话和分叉独立绑定权限。来源引用至少能区分会话和条目，遇到分叉时保留来源分支。
2. 由宿主管理 Hindsight 服务及其持久存储。将存储放在 Agent 可读工作区之外。仅把读权限授予 Agent 的 MCP 工具，宿主管理入口负责写入和确认。
3. 明确哪些材料可用于提炼候选。候选应带来源、适用条件和可核查的反例或限制。确认人核对提炼结果后再发布。应用根据业务需要配置模型和出站范围。

## 走一遍记忆生命周期

由宿主确认「资料摘要优先用表格」，为该主体和 Agent 开启共享，并在独立新会话询问采用何种形式。核对召回的正文、版本、来源和匹配依据。改用另一个主体或未经授权的分支重复查询，结果不应包含该条记忆。

把偏好更正为「资料摘要优先用清单」，核对新会话只采用新值。随后执行遗忘，验证应用重启后也无法从记忆服务召回。旧会话历史和已经传给模型的副本各有独立的保留规则，涉及这些副本时按其数据域处理。[开发 SOP](SOP.zh-CN.md)
