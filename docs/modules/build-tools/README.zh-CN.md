# 工具与业务能力

状态：合同与文档已对齐 `1.0.0` 发布线；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

通过内置工具、脚本工具或稳定 defineTool 契约连接确定性的业务动作。

## 公共接口

- `buildTools`
- `defineTool`
- `adaptCoreMindTool`
- `ToolEffectDeclaration`
- `ProcessRunner`
- `GitAdapter`
- `createUnifiedDiff`、`diffFiles`

## 错误与边界

- 工具加载失败会告警并跳过
- 工具异常会进入 tool_result 与失败预算
- 越权路径或 deny 规则会阻止执行
- 自定义工具缺少 `effect` 时配置或 SDK 定义直接失败；受约束模式不会猜测未知副作用
- `effect.operations` 可组合 `read`、`write`、`process`、`network`、`external`，`reversible` 必须如实填写
- 自定义工具不得使用 `read`、`write`、`bash` 等内置工具名，避免权限语义被错误继承
- Linux bash 沙箱初始化失败时关闭执行，不回退到宿主 shell
- `ProcessRunner` 不启用 Shell 拼接，限制 UTF-8 输出、执行时间和环境变量；调用方显式提供 `env` 时，该最小环境是权威输入，不会重新合并宿主环境，也不会被工具执行上下文覆盖
- `GitAdapter` 只开放固定的只读 status/diff/log，不允许任意子命令、写操作或路径逃逸
- 统一 Diff 同时限制输入、输出和计算复杂度，避免超大文件拖垮进程
- Windows 宿主 Shell 只有在 full、关闭工作区限制且允许网络时才开放；这是显式风险选择，不是隔离承诺
- 本地 MCP 按 Agent 精确选择，在 Run 内分别审批连接、目录和业务调用；仅支持明确开放的受信宿主程序，Child Run 不继承，静态 doctor 不启动服务。详见[指南](GUIDE.zh-CN.md#本地-mcp-服务)。
- HTTP MCP 使用固定 URL、Header 凭据引用和实际 socket 地址核验，拒绝重定向和环境代理；可选精确 IP 集合约束该目标的全部地址。HTTP 网络操作遵守既有网络审批，业务副作用声明不降级。资源仅支持 HTTP，按 Agent 的精确 URI 集合授权，空集合不继承；目录与读取按需，不自动解引用链接或宿主文件。取消单请求不关闭其他合法调用，Run 关闭只回收本地连接，远端 session 依赖服务租约；无 OAuth/刷新或业务自动重发。详见[HTTP 指南](GUIDE.zh-CN.md#受控-http-mcp-与资源)。

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-tools/src](../../../packages/coremind-tools/src)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-tools/src/process-runner.ts](../../../packages/coremind-tools/src/process-runner.ts)
- [packages/coremind-tools/src/git-adapter.ts](../../../packages/coremind-tools/src/git-adapter.ts)
- [packages/coremind-tools/src/unified-diff.ts](../../../packages/coremind-tools/src/unified-diff.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind-runtime/src/mcp-runtime.ts](../../../packages/coremind-runtime/src/mcp-runtime.ts)
- [packages/coremind-tools/src/registry.test.ts](../../../packages/coremind-tools/src/registry.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [packages/coremind-tools/src/process-runner.test.ts](../../../packages/coremind-tools/src/process-runner.test.ts)
- [packages/coremind-tools/src/host-shell.test.ts](../../../packages/coremind-tools/src/host-shell.test.ts)
- [packages/coremind-tools/src/git-adapter.test.ts](../../../packages/coremind-tools/src/git-adapter.test.ts)
- [packages/coremind-tools/src/unified-diff.test.ts](../../../packages/coremind-tools/src/unified-diff.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [HTTP 目标与网络边界测试](../../../packages/coremind-tools/src/mcp-http-fetch.test.ts)
- [HTTP 协议传输测试](../../../packages/coremind-tools/src/mcp-http-transport.test.ts)
- [HTTP 资源与结果测试](../../../packages/coremind-tools/src/mcp-http-client.test.ts)
- [HTTP Runtime 授权测试](../../../packages/coremind-runtime/src/mcp-http-runtime.test.ts)
- [HTTP Runtime 真实验收](../../../packages/coremind-runtime/src/mcp-http-runtime.acceptance.test.ts)
- [HTTP CLI 真实验收](../../../packages/coremind-cli/src/mcp-http-cli.acceptance.test.ts)
- [HTTP Python 同步/异步验收](../../../python/tests/test_mcp_http.py)
- [模块示例](../../../examples/modules/build-tools/README.zh-CN.md)
- [Module example](../../../examples/modules/build-tools/README.en.md)
- [Agent Skill](../../../skills/build-tools/SKILL.md)
