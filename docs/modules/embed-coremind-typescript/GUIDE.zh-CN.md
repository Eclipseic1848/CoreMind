# TypeScript SDK 上手指南

## 什么时候使用

通过 coremind-ai 单一门面在 Node 工程中嵌入 Runtime、工具、会话、显式 Loop、评测和事件。

## 最小示例

```text
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: '执行任务',
  toolDefinitions: [lookupOrder],
});
const result = await runtime.run();
console.log(result.snapshot.operation, result.snapshot.artifacts);
if (result.outcome.status !== 'succeeded') {
  console.error(result.outcome.error?.message ?? result.outcome.finishReason);
}
```

`lookupOrder` 必须由 `defineTool` 创建，并包含例如 `effect: { operations: ['read'], reversible: true }` 的真实副作用声明。`run()` 的正常终态都通过返回值表达；只把配置加载、Runtime 创建或调用方自身错误放进 `catch`。

需要业务宿主独立验收时，使用 `loop.verify.mode: host`；`onVerification` 仅通知候选，宿主核对 Run、requestId、candidateSha256 和业务对象后，通过 `runtime.acceptControl` 提交决定。`accepted` 仅表示收件，最终检查 `result.outcome`；完整离线代码见[宿主验收示例](../../../examples/host-verification/README.md)。

## 运行中追加输入（1.1 开发线）

通过 `new ChatSession(runtime, agentName)` 创建会话。当前 Run 已就绪时，UI 操作可调用：

```typescript
const receipt = await session.steer('先核对测试结果', {
  controlId: 'review-tests-1',
  runId: activeRunId,
});
const followUp = await session.followUp('自然停止后汇总风险', {
  controlId: 'summarize-1',
  runId: activeRunId,
});
```

`session` 与 `activeRunId` 由宿主持有；不要把刚调用 `chat()` 当作收件箱已就绪。steer 在后续可用 Turn 介入，followUp 等 Agent 自然停止后继续，两者都属于当前 Run。方法固定实际活动 owner，不在 await 后重新寻找下一轮；未绑定、未就绪、已封口或指定错误 Run 时拒绝。省略 controlId 会为该次调用生成新 ID；需要重试时保留原 ID，相同内容返回 duplicate，冲突内容返回 conflict。

`accepted` 只表示持久接收，`applied` 只表示应用事实提交后交付原生 Agent 队列；另有 rejected、duplicate、conflict。监听 `session.onEvent` 的 `input_receipt/input_claimed/input_completed/input_discarded` 区分排队、认领、完成和丢弃，并核对 inputId/TurnId。控制不替代工具审批，也不改变预算、权限或 Provider；独立宿主验收等待时会拒绝改变候选的输入。

accepted 控制在冷恢复的 Agent 就绪后按原身份应用。applied 已提交但未确认消费时不自动重投，只补明确 discarded；持久提交与内存交付的崩溃窗口仍存在。暂停的原输入可按原门恢复，普通已 discarded 输入仍不可恢复；这不是绝对 exactly-once，也不替代普通 Session 与压缩记录的完整请求重建。

## 显式 MCP 认证（1.1 开发线）

对配置了 `mcp.servers.remote.oauth` 的服务，由宿主持有认证会话：

```typescript
import { CoreMindRuntime, createMcpAuthentication } from 'coremind-ai';

const authentication = await createMcpAuthentication({ config });
try {
  await authentication.login('remote', {
    signal: controller.signal,
    onAuthorization: (request, signal) => {
      signal.throwIfAborted();
      showTemporaryAuthorizationLink(request.authorizationUrl);
    },
  });
  const runtime = await CoreMindRuntime.create({
    config,
    configDir: process.cwd(),
    initialPrompt: '读取已授权资源',
    mcpAuthentication: authentication,
  });
  const result = await runtime.run();
  console.log(result.outcome.status);
  await authentication.logout('remote');
} finally {
  await authentication.close();
}
```

示例中的 `config` 是已加载的配置，`controller` 和 `showTemporaryAuthorizationLink` 由宿主提供；UI 自行展示链接，不自动打开浏览器、不持久记录。缺 handler 的 login 在任何认证 I/O 前返回 typed `mcp_auth_required`。普通 Run 没有认证会话时也明确暂停；它不会隐式登录。Run 不拥有会话关闭权，可在同一宿主跨 Run 复用，Child Run 不接受认证引用。

默认内存模式重启需重登。安全持久化由显式 `tokenStore` 和稳定隔离的 `namespace` 提供，接口只有 `load/save/delete`，接缝含凭据，不可序列化到 Worker、事件或日志。存储需原子保存并响应取消，错误关闭本地授权，不回退旧 Token。logout 删除记录并撤销本地使用；close 清理本地事务但保留显式存储。远端撤销、跨 origin 认证、动态注册不在当前支持范围；真实外部服务互通未验证，配置边界见[配置指南](../../guide/02-configuration.md)。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/embed-coremind-typescript/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对 `failed`、`paused`、`aborted`、`timeout`、`budget_exceeded` 分别写调用方分支测试。
6. 使用 `config.loop` 时收集 `loop_state`，验证暂停恢复不会重复完整步骤或 committed 副作用。
7. 对外传递结果时使用 `result.snapshot`，不要直接序列化 `outputs` 或 `messages` 中的 Map。
8. 对控制验证目标 Run、重复/冲突、提交失败、审批等待、取消丢弃与冷恢复；回执不能代替实际请求正文及输入事件证据。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计、Effect Receipt 或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
