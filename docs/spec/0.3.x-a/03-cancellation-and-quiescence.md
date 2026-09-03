# 0.3.x-A 规格：取消收敛、输入收据与静止

> 配套 ADR：[0003-cancellation-quiescence-and-input-receipts](../../adr/0003-cancellation-quiescence-and-input-receipts.md)
> 状态：accepted（2026-08-16）

## 1. 取消词汇契约（单一事实源）

| 词 | 定义 | 现状落点 | 0.3.x-A 落点 |
| --- | --- | --- | --- |
| Cancel | 外部取消请求 | signal / worker `cancel` / SIGINT / `/abort` | 统一为"请求"语义 |
| Abort | 活动被终止的事实时刻 | `runWithGuard.triggerGuard` | triggerGuard 即 Abort 生效点，调用 `journal.markAborted()` |
| aborted | Run 终态 | outcome | 不变 |
| Timeout | 超时终止（run/step 两层） | runWithGuard / executeLoopStep | 与 Abort 共用准入机制，各自错误码 |
| BudgetExceeded | 预算终止 | budget 三路径 | 与 Abort 共用准入机制 |
| Interrupt | Loop 内部触发动作 | LoopRunner.interrupt | 内部词汇，不进公共事件 |
| Quiescent | 静止：无在飞活动、无未 flush 写入 | 无 | 新增判定与 `waitForQuiescence()` |

## 2. 错误码码表（单一事实源）

errors.ts 升级为码表模块：

```
取消类：aborted / run_timeout / step_timeout / budget_exceeded
暂停类：loop_paused / tool_approval_denied
恢复类：resume_input_mismatch / run_already_finished / operation_not_resumable /
        committed_effect_pending / unknown_effect
损坏类：run_state_corrupt / run_state_conflict / run_state_locked / checkpoint_corrupt /
        checkpoint_conflict / loop_snapshot_invalid / loop_snapshot_mismatch / session_layout_conflict
```

每个码固定三个分类属性：`terminality`（terminal / pausable / transient）、`cancelClass`（cancel / timeout / budget / human / corruption）、`retryClass`（human / transient / fatal）。retry-policy 的 HUMAN_CODES / TRANSIENT_CODES、run-terminalizer 的 statusFromCode、CLI 退出码映射**全部改引码表**，删除三处字符串集合。

## 3. 事件准入规则（journal 内实现）

- `journal.markAborted()` 设置 Run 级分界点（记录 abort 时刻的 sequence 水位）
- 分界点之后的写入分类处理：
  - **收尾事实**（operation 记录、loop 快照、pause、finish）：始终放行（取消收敛自身需要它们）
  - **活动事实**（event 记录）：若属于旧活动（TurnId/StepId 早于或等于分界 Turn/Step）且为终态类事件（`tool_result`、`turn_end`、assistant 文本落定、`effect_receipt` 终态）→ **拒绝写入**，计数并记入 metrics（`rejected_after_abort`）
  - 非终态事件（如 `approval_required`）在 abort 后仍可放行（审批状态是取消路径的组成部分）
- 拒绝是静默语义：不抛错、不中断取消路径，只保证"迟到事实不入事实域"

### transcript 泄漏修复

现状 [runtime.ts:860-862](https://github.com/Eclipseic1848/CoreMind/blob/main/packages/coremind-runtime/src/runtime.ts) 的回退会捞入竞态赢家文本。契约：transcript 回退仅在 `abort 未生效且 terminalError 存在`时允许；abort 生效后 transcript 以已确认事实为准，未确认部分丢弃。

### 会话树写入（联动 D-4）

aborted Run 的会话树写入策略二选一（未决决策 D-4）：
- 方案 A：只写已确认部分（abort 前完成的 assistant 消息），竞态赢家文本不写；
- 方案 B：写带 `stopReason:"aborted"` 标记的截断消息。
默认推荐 A（事实域不掺入未确认内容）。

## 4. 输入收据（InputReceipt）

### 状态机

```
pending → claimed → completed
        ↘ discarded
```

- **pending**：输入已收到、尚未被任何活动消费
- **claimed**：输入被一个 Run/Turn 认领（绑定 TurnId）
- **discarded**：因取消/竞态被明确丢弃（如 abort 后到达的排队输入）
- **completed**：输入对应的活动已终态

### 持久化

`input_receipt` 事件落入 Run 事实（kind:event），携带：输入 ID（稳定，`randomUUID` 或 `sha256(sessionId + seq)` 二选一，实现期定）、状态、绑定的 TurnId、时间戳。状态转移是追加事件（`input_claimed` / `input_completed` / `input_discarded`），由事件序列折叠出当前状态——不覆盖旧记录。

### 接入点

- headless：`initialPrompt` 在 Run start 时 claim，终态时 complete
- chat/TUI：每轮 message 是该轮 Run 的输入（claim 于该 Run start）；abort 后队列中未消费的输入 → discarded
- worker 协议：run/chat 请求到达时生成输入 ID，收据随事件通知流出
- Resume：恢复时校验输入收据与 `resume_input_mismatch` 联动（现状校验保留）

## 5. 静止判定（Quiescent）

```
quiescent ⇔ 所有 agent 已 idle
         ∧ 无 pending 工具结果（pendingToolCalls 为空）
         ∧ journal 无 pending flush（append 队列空且已落盘）
         ∧ 准入拒绝后无在飞旧活动事件
```

- `waitForQuiescence()`：Runtime 层接口，runWithGuard 收尾路径调用，返回 promise；超时上限与 runTimeout 解耦（独立 quiescenceTimeout，默认 5s，超时记录 `quiescence_timeout` 事件但不改变终态）
- 验收指标：本地假 Provider 下 Cancel → Quiescent p95 < 250ms（真实 Provider 的传输层延迟单独记录，不混入运行时指标）

## 6. 竞态窗口处置（对应勘察 R1–R10）

| # | 窗口 | 0.3.x-A 处置 |
| --- | --- | --- |
| R1 | abort vs 流完成（transcript 泄漏） | 准入规则 + transcript 契约（§3） |
| R2 | 多次中止 | 现状已幂等（guardTriggered 首次胜出），补显式测试 |
| R3 | 工具执行中 abort | 现状：已启动工具完成并记录。契约：其 receipt 终态属于分界点**之前**启动的活动，放行；分界点后启动的一律拒绝（靠 TurnId 判定） |
| R4 | abort 后立刻 resume | 现状 finish + operation failed 双拒绝；补端到端测试 |
| R5 | step 超时 vs 完成 | 输出丢弃、错误码 step_timeout 保持；补测试 |
| R6 | 预算 abort 语义竞争 | 保持"同步骤内 budget 语义胜出"；跨步骤误报记入已知限制（0.3.x-B 再收口） |
| R7 | 同实例并发 run() | **登记为契约**：CoreMindRuntime 实例不支持并发 run()；0.3.x-A 加运行时检测（并发调用直接抛 `concurrent_run` 错误码），串行化属 0.3.x-B |
| R8 | 快照落盘 vs finish | runWithGuard 的 await 顺序保持；sendAndPersist 先 send 后 persist 的一致性补强属 0.3.x-B |
| R9 | 恢复输入校验 | 与输入收据联动（§4） |
| R10 | 重复 operation 事件 | 现状 eventId 幂等，保留 |

## 7. 已决决策（2026-08-16）

- **D-1（协议扩展）**：run/chat 请求增加可选 `runId` 字段（客户端预生成），解决首事件前无法取消；向后兼容，旧客户端行为不变。
- **D-4（abort 后会话树写入）**：方案 A——只写已确认部分，竞态赢家文本丢弃（见 §3）。
