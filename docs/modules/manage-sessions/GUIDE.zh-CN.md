# Session 与 Context上手指南

## 什么时候使用

保存多轮消息、严格恢复损坏错误，并在 Provider 调用前进行确定性的上下文保护。

## 最小示例

```text
session:
  enabled: true
  dir: ./.coremind/sessions
  compact: false
```

只有启用后才能使用 CLI 的 `--session <id>`。如果配置未启用，CLI 会明确失败并提示修正。

`session.compact` 控制旧 `ContextProtector` 行为，不会关闭 Runtime 的模型感知预算。只要当前请求超过可用输入预算，Runtime 就会尝试构建有界 Working Set；若确实需要压缩，必须同时存在已启用且可写入的 Session，摘要不能只保存在进程内存中。

不同模型的窗口和输出上限可以不同。Runtime 会在每次请求和模型切换时重新解析能力，并将本次实际 `maxTokens` 原样纳入预算；不会用窗口比例静默缩小调用方请求。

## TypeScript 会话树（1.4 开发线）

```ts
import { ChatSession, CoreMindRuntime, type ChatSessionNodeRef } from "coremind-ai";

// options 为已校验的宿主配置，开启 session.enabled 并指定 sessionId。
const chat = new ChatSession(await CoreMindRuntime.create(options), "main");
await chat.chat("第一问");
const tree = await chat.inspectSessionTree();
const entry = tree.nodes.filter((node) => node.type === "message").at(-1)!;
const at: ChatSessionNodeRef = { sessionId: tree.sessionId, entryId: entry.id };
await chat.createBranch("alternative", at);
await chat.selectBranch("alternative");
await chat.chat("从这一分支继续");
const fork = await chat.fork(at);
const forkChat = new ChatSession(await CoreMindRuntime.create({
  config: options.config, configDir: options.configDir, cwd: options.cwd,
  sessionId: fork.sessionId,
  // 按宿主策略重新提供 secretResolver、approveTool 等能力，不复制运行身份。
}), "main");
await forkChat.chat("在新会话继续");
```

- createBranch(id, at) 从消息节点建分支；at 为 null 表示空历史。名称为 1–64 位字母、数字、连字符或下划线；创建不自动选择，main 是初始分支。
- selectBranch(id) 持久切换整个 Session 的活动分支，下一轮只读取并追加该分支。它不是单个 Chat 对象的私有选择；旧对象会因水位过期拒绝，须重新打开 Runtime/Chat。
- inspectSessionTree() 返回 sessionId/activeBranch/branches/nodes/forkedFrom? 副本。nodes 是全树，含未脱敏消息；宿主必须限制访问。节点引用必须绑定本会话 sessionId，即使 fork 复制的历史 entryId 相同也不能混用。
- fork(at) 包含该消息及祖先，返回新会话身份，不修改来源；不接受目标 id 或路径。重新应用宿主配置，不传来源 runId/resumeRunId/protocolStart。原 Run、未消费控制、收据、checkpoint 和凭据授权不复制；历史工具 id 不授予执行能力。
- 导航要求启用持久化、主 Agent 和无活动 Run/导航/writer。查询也要求空闲，可能执行既有打开修复。参数错误为 session_navigation_invalid，并发为 concurrent_run/session_write_locked，旧视图为 session_snapshot_stale。
- 每轮 chat 创建独立 Run/Agent，Runtime 在收敛阶段落盘；persist() 只返回最近一轮路径，不触发保存。

选择写入拒绝可能发生在实际落盘之后；保留文件，重新打开查询，不能假定回滚。fork 的公开别名失败可能留下完整内部候选；按错误路径核实身份再打开，不盲目重新 fork 或删除来源。

旧 v3/v4 无分支数据兼容。旧 SDK 不理解持久选择，禁止直接接管新文件；回滚须停 writer、保全完整 Session/Run/Workspace 并恢复升级前备份。本 API 不是 第三方 ExtensionAPI，也不恢复原 Run。Python/RPC 导航见 [跨语言指南](../embed-coremind-python/GUIDE.zh-CN.md)。见 [ADR0029](../../adr/0029-public-session-tree-navigation.md)与[可运行示例](../../../examples/modules/manage-sessions/branches.mjs)。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对旧保护器注入一次压缩失败，确认原消息保留并出现 `context_compaction_failed`；再对模型感知生命周期注入未知能力、无 Session 压缩、Artifact 漂移和 lineage 损坏，确认出现 `context_lifecycle_failed` 且 Provider 调用计数为 0。
6. 用至少两个不同窗口的模型配置重复长任务，检查 `context_budget_resolved` 的来源、置信度、实际输出保留量和各项输入占用。
7. 触发压缩后检查摘要六个必备部分、上一完整 Turn、当前 user 消息、Session 条目引用和 Ledger 父链；连续压缩达到阈值时确认从 canonical Session 消息重建。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把估算 token 当成 Provider 的绝对真值；边界误差由安全余量和 Provider 超窗后的单次暂停处理，不能重发同一请求碰运气。
- 不要在关闭 Session 的长任务中依赖内存摘要；需要压缩时 Runtime 会暂停。
- 不要把继承 Provider 误称为已通过真实认证。
