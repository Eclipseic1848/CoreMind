# 0.3.x-A 规格：类型化身份与关联不变量

> 配套 ADR：[0002-typed-identity-and-correlation](../../adr/0002-typed-identity-and-correlation.md)
> 状态：accepted（2026-08-16 用户确认）

## 1. 身份层级

```
Run (RunId)
 └─ Step (StepId，Run 内唯一)
     └─ Turn (TurnId，新引入)
         └─ Call (CallId，透传上游 toolCallId)
             ├─ EffectReceipt (ReceiptId = 规范化 idempotencyKey)
             └─ Approval (ApprovalId)
 └─ Operation (OperationId，与 Run 1:1)
 └─ Checkpoint (CheckpointId)
 └─ Trace Event (EventId + per-run sequence)
```

## 2. 品牌 ID 契约

- TS 内部：品牌类型 `type RunId = string & { readonly __brand: "RunId" }` 等，编译期禁止跨类错配
- 协议边界（JSON-RPC / CLI 输出）：序列化为字符串；新增格式校验：UUID 或 `^[a-zA-Z0-9_-]+$`（沿用现有边界正则）
- 派生 ID：`ReceiptId = "${runId}:${stepId ?? "agent"}:${callId}"` 规范化，**合并现有两处实现**（run-effect-coordinator.ts:92-94 与 runtime.ts:1145-1147）为单点
- 品牌类型定义位置：coremind-runtime 内定义并导出；coremind-protocol 只做字符串层校验，**不引入反向依赖**

### StepId 唯一化

现状 loop 模板 `loop-execute` 在同一 Run 内多次出现（每次 iteration 复用），违反"Run 内唯一"。

契约：loop 场景 StepId 规范化为 `loop-execute:${iteration}` / `loop-verify:${iteration}` / `loop-repair:${repairCount}`；workflow 场景保持用户配置字符串，Run 开始前校验唯一性（重复即配置错误，失败关闭）。0.3.0 历史记录的旧格式 StepId 在读取时按原样保留，不重写。

### TurnId 引入

- Turn = Agent 与 Provider 的一次请求-响应回合；TurnId 由 harness 在 agent_start 时分配（randomUUID），turn_end 时关闭
- `turn_end` 事件新增 `turnId`（现状无）；`tool_call` / `tool_result` / `effect_receipt` 事件携带所属 `turnId`
- 0.3.0 历史事件无 turnId：关联不变量检查对旧记录跳过 Turn 级检查（显式声明，不猜测）

## 3. 关联不变量清单（可独立执行的检查器）

检查器接口：`check(facts) → Violation[]`；分三档开启：off（默认生产）/ eval（debug、评估）/ gate（release gate）。

| # | 不变量 | 说明 |
| --- | --- | --- |
| I-1 | journal sequence 连续无洞 | 现状已有，升级为可独立执行的检查 |
| I-2 | 幂等追加：同 sequence 同内容成功、异内容 conflict | 现状已有 |
| I-3 | 终态（finish）之后无新记录 | 现状 journal 拒绝，补显式测试 |
| I-4 | Run 内每个 StepId 唯一 | 新增（配合 StepId 唯一化） |
| I-5 | TurnId 属于当前 Run；Call 的 TurnId 匹配其产生时所在的 Turn | 新增 |
| I-6 | ReceiptId 的 runId/stepId 前缀与当前 Run/Step 一致 | 新增 |
| I-7 | 每个工具 Call 恰有一个可解释终结（receipt 终态 or 工具失败事件） | 新增；孤儿 Call（无 tool_result）必须显式关闭 |
| I-8 | Checkpoint 的 runId/operationId 匹配其所在 Run | 现状校验升级 |
| I-9 | approval_required 与 approval_resolved 的 approvalId 一致且配对 | 新增（现状无任何断言） |
| I-10 | abort 分界点后无旧活动终态事实（与规格 03 准入规则联动） | 新增 |
| I-11 | 恢复的 operation 事件链：首条 ACCEPT、sequence 连续、迁移合法 | 现状已有，纳入检查器 |
| I-12 | effect receipt 状态转移合法：not_started → started → committed/unknown，无回退 | 新增 |

检查器读取 Run 事实（journal records）+ Session 事实（关联部分），不修改任何事实。

## 4. 关联的持久化增量

- RunState `start` 记录新增可选字段：`sessionId`、`sessionSeqStart`、`turnSeqStart`（见规格 01）
- `turn_end` 事件新增 `turnId`；新事件 `input_receipt`（见规格 03）携带输入 ID 与状态
- 全部为**可选追加字段**，schemaVersion 保持 1，0.3.0 数据零迁移（符合"0.3.x 不破坏公共合同"）

## 5. 已决决策（2026-08-16 用户确认）

- **D-5（公共 API 面）**：品牌 ID 仅 TS 内部使用，SDK 公共导出面保持 string，公共合同零变化；错误码码表同样不承诺为公共 API（内部单一事实源，公共面仍为字符串码）。
