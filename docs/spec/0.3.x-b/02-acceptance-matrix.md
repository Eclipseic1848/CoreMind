# 0.3.x-B 规格：故障注入与验收矩阵

> 配套规格：[可信工具执行](01-trusted-tool-execution.md)
> 状态：accepted（2026-08-22 用户确认）
> 本文件定义未来实现门，不声称门已经通过

修订记录（2026-08-23，Issue #67）：本次仅更正与主规格“不引入 MCP、Subagent”及后续版本路线冲突的验收表述，并区分当前 Runtime/OS 进程证据与未来 Worker/Child Run 证据；不改变 Config、Protocol、权限、安全边界或 0.3.x-B 已承诺的实现范围。

## 1. 必测写入与执行切点

对 Workspace write、process、network、external 和 unknown 工具，在以下切点分别注入同步异常、异步拒绝、进程崩溃与 Cancel：

1. call Fact 写入前/后；
2. Capability 与 Policy 决策前/后；
3. approval Fact 前/后；
4. Workspace Lease 获取前/后；
5. Checkpoint 创建、发布与 barrier 前/后；
6. `started` Receipt 排队前、Store commit 中、Durability Barrier 确认后；
7. Tool Adapter 调用前、执行中、返回后；
8. result Fact 与 Effect 终态写入前/后；
9. Lease 释放、子进程终止、journal flush 与 Run terminal 前/后。

## 2. 硬性不变量

| 编号 | 不变量 |
| --- | --- |
| B-1 | `started_durable` 失败时，真实外部 Effect 次数为 0 |
| B-2 | non-idempotent 或 unknown Effect 一旦可能 started，自动 Resume 执行次数为 0 |
| B-3 | 同一 ReceiptId 不得关联不同参数指纹、Run、Turn、Call 或 Capability |
| B-4 | 已交付的 Built-in、Python 与 Script Tool 只能在 `ToolExecutionEngine` 的 `executing:completed` 后进入 Adapter；Policy 与 Extension 只能阻断或收紧，不能直接调用 Adapter |
| B-5 | Tool Capability 在一次 Call 内不可变，任何后续决策只可收紧 |
| B-6 | 同一 canonical Workspace 同时持有的写租约不超过 1 |
| B-7 | Lease 释放时，所属工具、子进程和关键尾部 Fact 已 Quiescent |
| B-8 | External Observable Read 状态未知时不得自动重放 |
| B-9 | Tool Error、EffectState、PersistenceState、RecoveryDisposition 与 CleanupState 可独立断言 |
| B-10 | CLI、TUI、TypeScript 与 Python 对相同 Fact 生成相同结果与 RecoveryDisposition |

## 3. 场景矩阵

### 3.1 Capability 与 Policy

- 为每个内置工具生成 Capability snapshot，防止 Config、Policy、Checkpoint 与 Resume 漂移。
- 注册缺字段、冲突声明和未知工具，断言使用最严格 fallback。
- Extension 尝试把 unknown 降为 pure read，断言拒绝并产生可观测原因。
- 网络读取断言为 External Observable Read，不进入 pure local read replay 路径。

### 3.2 Durability

- Fake Store 分别声明 `ordinary`、`critical` 与 unsupported；验证安全关键 Fact 只接受满足请求等级的 Adapter。
- 注入“内存 enqueue 成功、实际 commit 失败”，断言 Tool Adapter 从未被调用。
- 注入 Tool 返回后 result barrier 失败，断言 ExecutionOutcome 保留 `returned`，PersistenceState 为 `failed`，EffectState 不被重置。
- 真实 File Store 在 Windows/Linux 运行平台级 crash probe；报告必须写明验证的是进程崩溃边界还是更强持久化边界。

### 3.3 Workspace 并发

- 两个 Runtime，以及两个独立 OS 进程所有者同时写同一 canonical Workspace，只允许一个取得 Lease。
- 相对路径、路径大小写、symlink/junction 指向同一根目录时仍视为冲突。
- 两个隔离 Workspace 可并行写；读操作不被无关写租约全局阻断。
- Owner 崩溃后 Lease 不得静默转移；先完成遗留判定与 RecoveryDisposition。

本批不引入 MCP、ProtocolHost 或 Child Run，因此不把“真实 MCP Adapter”“两个独立 WorkerServer”或“父子 Run”列为 0.3.x-B 已完成证据。后续能力必须复用同一个公开 `CoreMindToolDefinition` / `WorkspaceLeaseService` seam，并在各自批次补真实入口验收；不能用本批的 Runtime 或进程所有者探针替代。

### 3.4 网络读取的 Resume 处置

- 已持久化结果且参数指纹一致：复用结果，网络调用计数为 0。
- 幂等证明成立：创建新 attempt 后重试，旧 Receipt 保持不可变。
- 请求可能到达但无结果：暂停，网络调用计数保持不变。
- 一次性 URL、计费搜索和限流 API fixture 均覆盖 unknown 路径。

### 3.5 当前 Tool 入口

- Built-in Tool：真实 Runtime 测试分别证明 Policy/Approval 与 Extension 拒绝时 `executing` 为 `skipped`，没有 `executing:completed`。
- Python Tool：真实 WorkerServer、Runtime、本地 Provider 与 `python_tool_call` 往返测试证明通知发生在 `executing:completed` 之后。
- Script Tool：配置加载真实脚本模块，并在完整 `ToolExecutionEngine` 生命周期后进入脚本 Adapter。
- MCP 属于未来批次；本矩阵不生成虚假的 MCP 来源标签，也不把公共 seam 的单元测试宣传为真实 MCP 验收。

## 4. 竞态与属性测试

- 使用固定 PRNG 种子组合并行 batch、Cancel、timeout、Store failure、Worker exit、Lease contention 与 late result，至少运行 1,000 个可复现种子。
- 每个种子检查 B-1～B-10、现有 I-1～I-12、无悬挂 Promise、无遗留进程、无锁泄漏。
- 失败报告必须包含种子、Call/Receipt/Run 身份、切点和最小 Fact 前缀，不包含凭据或未脱敏正文。

## 5. 回归门

- 目标测试、全量单元/集成测试、typecheck、lint、public API baseline、Markdown 审计全部通过。
- `runtime.ts` 拆分不得改变 CLI/TUI/TS/Python 的现有成功路径、错误码或公开 Schema。
- 0.3.0 与 0.3.1 fixture 仍可读取；缺失新字段时输出明确 legacy/unknown 处置。
- Windows/Linux 均运行真实文件锁、路径规范化、子进程树与 File Store crash probe。

## 6. 证据边界

本矩阵通过仅证明 0.3.x-B 工程合同。它不能替代真实 Provider、MCP、Subagent、远程环境、产品体验、Release Readiness、Git 提交或发布授权。
