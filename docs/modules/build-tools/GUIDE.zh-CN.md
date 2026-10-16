# 工具与业务能力上手指南

## 什么时候使用

通过内置工具、脚本工具或稳定 defineTool 契约连接确定性的业务动作。

## 最小示例

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  effect: { operations: ['read'], reversible: true },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

`operations` 描述工具实际会做什么，不是它的业务名称。读取数据库填 `read`；修改文件填 `write`；启动进程填 `process`；访问 HTTP 服务填 `network`；无法归入前述类别填 `external`。只有框架确实能自动还原全部副作用时才可设置 `reversible: true`。非标准路径或 URL 参数可用 `pathFields`、`urlFields` 声明，例如 `pathFields: ['output.path']`。

工具名必须是业务专用名称，不能使用内置 `read`、`write`、`bash` 等保留名。SDK 定义和脚本注册都会在执行前拒绝冲突。

## 本地 MCP 服务

按[配置指南](../../guide/02-configuration.md#mcp按-agent-选择本地工具)声明已审核程序及每个 Agent 的原始工具引用。CLI、TypeScript 和 Python 共用 Node Runtime；Python 不另建客户端。不要通过全局 SDK `toolDefinitions` 注入远端目录。

先用 `coremind doctor coremind.yaml` 做静态检查，再在明确开放的 `workspaceOnly: false`、`network: allow` 条件下运行。`ask` 会分别询问连接、目录与业务动作；显式 deny 仍优先。连接和目录先消耗两次工具预算，业务工具必须如实声明完整 Effect/Capability。受信程序不是沙箱，既有项目质量门对无限工作区仍失败，Child Run 不继承该能力。

在仓库根目录运行 `npx vitest run packages/coremind-tools/src/mcp-stdio-client.test.ts packages/coremind-tools/src/mcp-stdio-transport.test.ts packages/coremind-runtime/src/mcp-runtime.acceptance.test.ts`，核对审批拒绝时对应 I/O 为零、首次模型 schema、真实进程回收、秘密输出阻断和未知效果不重发。协议错误与业务 `isError` 分开处理，未经证明的写效果不能靠重试恢复。

Windows 本地服务仍使用系统 Windows PowerShell 与专属 Job。启动时从随包固定 DLL 的实际字节计算 SHA-256，再加载同一字节数组；普通安装和运行不会调用 C# 编译器或导入 PowerShell Utility 模块。缺失或摘要不符会拒绝启动，不降级为未受控进程。该程序集依赖 Windows 自带的 CLR 4 系列 Framework，不引入 .NET SDK 或 NuGet；它不将受信宿主程序变成沙箱，也不保证任意系统策略或负载下都能按时启动。

## 受控 HTTP MCP 与资源

按[HTTP 配置](../../guide/02-configuration.md#mcp受控-http-与精确资源授权)固定 `streamable-http` URL，URL 不含 userinfo、query 或 fragment。`headers.Authorization.env` 引用的值必须完整包含 `Bearer ` 等认证前缀；也可复用 `secretRef`，不得把令牌写入配置。401/403、缺失或无法解析的凭据明确失败，不自动 OAuth、刷新或更换身份。

无 `allowedAddresses` 时，HTTPS 只允许核验后的公网地址；非空列表是该 endpoint 全部地址的精确 IP 约束，私网也须显式列入。明文 HTTP 必须同时使用 loopback IP 字面 URL 和匹配的允许地址。DNS 答案与实际 socket 地址保持绑定，TLS 主机名校验保留；所有重定向拒绝，不读取环境代理。`doctor` 不联网。

HTTP 连接、目录、资源读取走原网络权限。`network: allow` 已构成配置批准，`mode: ask` 不会再次询问；`network: ask` 仍按原网络审批。真实业务 `external`、显式 deny 和工作区硬门保持不变。Child Run 不继承 MCP、资源或凭据。

按 Agent 显式选择完整 URI，例如 `mcpResources: {remote: ['fixture://first']}`。缺省和空集合都不授权、不继承；只支持 HTTP 资源。list、templates、read 按需调用，模板不会扩权，读取响应也不得夹带未授权 URI。不要把 `file:` 当宿主文件接口；链接与 HTML 不会被解引用或执行，blob 明确不支持。只用资源且未继承 MCP 工具时，首个模型请求前没有 HTTP I/O；只用工具时不隐式请求资源目录。

单 body 8 MiB、owner 累计 64 MiB、目录 32 页/256 条、请求及目录总期限 30 秒；owner 的 GET 恢复最多 3 次/30 秒，业务 POST 不自动重发。取消单请求不应关闭其他合法调用。Run 关闭等待本地 body/socket/dispatcher，不发送远端 DELETE；远端 session 依赖服务租约清理。秘密不得进入 prompt、Facts、异常或 Worker JSON，较大安全正文沿用 Artifact。

按 [module.yaml](module.yaml) 中的 HTTP fetch/transport/client、Runtime、CLI 和 Python 测试逐项验收允许、拒绝、取消与未知效果，并保留原 stdio 回归。这里是执行合同和验收步骤，不代表全部测试或真实外部服务互通已经通过。

## MCP 认证所有权（1.1 开发线）

HTTP 服务的可选 `oauth` 与 Authorization Header 互斥。认证由显式宿主 session 拥有，工具只借用私有绑定，不把 Token 交给模型或协议。复用同一完整 serverIdentity 的刷新仍按调用独立取消，最后等待者取消才中止共享刷新；注销先撤销使用权，迟到结果不能发布。HTTP 401 不重发业务 POST。秘密过滤跟随当前与在飞旧 Token，覆盖 Header、分块、解析结果、拼接和 Artifact。

默认内存、显式安全 TokenStore、网络准入、服务支持限制及真实外部服务未验证范围，见[配置指南](../../guide/02-configuration.md)。TypeScript、CLI、Python 的入口调用同一 Node 引擎；不能在工具实现中隐式弹浏览器或新建认证会话。按 module.yaml 新增认证测试覆盖完整授权与反例，不把本地夹具当作外部认证。

## 编码工具边界

```ts
import { GitAdapter, ProcessRunner, diffFiles } from "coremind-ai";

const tests = await new ProcessRunner().run({
  command: process.execPath,
  args: ["--test"],
  cwd: process.cwd(),
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

const git = new GitAdapter({ cwd: process.cwd() });
const status = await git.status();
const patch = await git.diff();
const preview = await diffFiles("src/before.ts", "src/after.ts");
```

`ProcessRunner` 接受命令与参数数组，不接受一段待 Shell 解释的拼接字符串。需要显式传递环境变量时，只传任务所需键值；该 `env` 会作为权威环境使用，不会再与宿主环境合并，也不会被工具执行上下文覆盖。默认不应把密钥复制给子进程。`GitAdapter` 是证据读取器，不提供 checkout、add、commit、reset、clean 或 push。统一 Diff 只适合受限大小的文本文件，超限会明确失败。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/build-tools/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 分别测试嵌套路径越界、网络拒绝、重复调用和工具异常；确认策略在执行前阻断。
6. 分别测试进程超时、中止、输出上限、缺失命令、Git 链接逃逸和超大 Diff。
7. 在 Windows 同时覆盖 Git Bash、PowerShell 回退和显式最小环境；确认运行上下文不能覆盖调用方提供的 `env`。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
