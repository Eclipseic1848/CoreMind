# 0.3.x-A 规格：事实域与请求重建

> 配套 ADR：[0001-fact-domains-and-projections](../../adr/0001-fact-domains-and-projections.md)
> 状态：accepted（2026-08-16）
> 本规格只描述设计契约，不修改代码

## 1. 事实域契约

三个事实域各自权威、互不重叠，关联键显式连接：

| 事实域 | 物理形态 | 内容 | 脱敏 | 权威性 |
| --- | --- | --- | --- | --- |
| Session 事实 | `sessions/<sessionId>.jsonl`（会话树） | 消息全量：user/assistant/tool call/tool result、压缩条目 | 否 | 消息内容唯一权威 |
| Run 事实 | `.coremind/runs/<runId>.jsonl`（RunState journal） | start/resume/event/checkpoint/loop/operation/pause/finish 记录 | 是 | Run 内事件、状态机、收据唯一权威 |
| Workspace 事实 | `.coremind/checkpoints/<runId>/<checkpointId>.json` | 文件前后内容快照 | 否 | 文件状态唯一权威 |

### 关联键（新增）

| 关联 | 现状 | 0.3.x-A 契约 |
| --- | --- | --- |
| Run → Session | 无 | start/resume 记录新增可选 `sessionId` + `sessionSeqStart`（该 Run 开始时会话树 seq 水位） |
| Checkpoint → Run/Call | 已有 toolCallId/idempotencyKey | 规范化：CheckpointId、RunId、ReceiptId 三键必填校验 |
| Turn → Run | 无 | TurnId 品牌 ID，见规格 02 |
| Receipt → Call | idempotencyKey（两处重复实现） | ReceiptId = 规范化 idempotencyKey，单点实现 |

### 投影清单（可丢弃、可重建）

- RunSnapshot（含 resumable 判定）——现状 snapshot.ts 与 run-state.ts 的安全门**双实现**，0.3.x-A 收敛为单一实现（[#现有缺口] G-1）
- 会话上下文视图（buildContext）
- CheckpointDiff
- RunResult.metrics / outcome / evaluation
- TUI 状态（MessageView、pendingApproval、lastRun）

投影不得被当作恢复或审计的事实输入。

## 2. Provider 请求重建契约

**目标**：从持久事实规范化重建每次 Provider 请求的消息列表，与实际发送值一致。

### 2.1 重建公式

```
请求 = buildStableContextPrefix(config)  // 确定性，逐字节可重建
     + applyCompaction(会话树 branch 消息, 压缩条目序列)
     + 本轮 Turn 消息（Run 事实内的 event 序列 + 会话树新条目）
```

### 2.2 压缩落盘（缺口补法）

现状：`ContextProtector.transform` 的摘要只存在于内存，事件只留 fingerprint，导致"实际发送"与"持久记录"永久偏差。

契约：

- 每次请求级压缩发生时，把压缩条目（摘要文本、替换范围 [起始条目 id, 结束条目 id]、tokensBefore、fingerprint）作为**会话树条目**落盘（追加，不删除历史）；
- RunState 的 `context_compacted` 事件只保留指纹 + **会话树条目引用**，不持久化摘要正文（摘要可能含敏感内容，遵守"Run 事实脱敏"原则）；
- 重建时按条目引用应用替换，重建结果与发送值逐条比对。

### 2.3 重建边界声明

| 情况 | 重建能力 |
| --- | --- |
| 0.3.x-A 之后产生的 Run | 100% 可重建（含压缩应用） |
| 0.3.0 历史 Run（无压缩） | 可重建消息序列；无 sessionSeqStart 关联，跨轮归属无法回答 |
| 0.3.0 历史 Run（发生过运行时压缩） | 只能断言 fingerprint，摘要不可得；明确声明不可完整重建 |
| 重试/断流（provider 层） | 记录重试边界事件（见规格 02 的关联不变量）；未发送成功的请求不要求重建 |

## 3. 状态与写入准入（Run 事实）

- journal 仍是 append-only、sequence 连续、幂等追加（同 sequence 同内容成功、异内容 conflict）——**保留为不变量**
- journal 增加 `markAborted()` 后进入准入模式（见规格 03）
- 三个事实域的写入失败语义：Session/Run 事实失败关闭（现状保留）；Workspace 事实（checkpoint 文件）补原子写入（temp + rename，现状非原子是 [现有缺口] G-2，属 0.3.x-B 工具与恢复批的修复项，0.3.x-A 只声明契约不实现）

## 4. 现有缺口登记（本批实现项）

- G-1：resumable 安全门双实现合并（snapshot.ts:42-55 / run-state.ts:413-432）
- G-2：checkpoint 写入非原子——**登记到 0.3.x-B**，0.3.x-A 不实现
- G-3：journal promise 链毒化（一次 append 失败后所有后续追加被毒化）——0.3.x-A 实现"失败后明确报错 + 可观测"，自愈策略属 0.3.x-B
- G-4：Trace 同一事件三处并存（collected 原文 / trace 脱敏 / journal）——0.3.x-A 声明唯一权威是 journal（脱敏版），内存副本只服务当前请求与回调

## 5. 已决决策（2026-08-16）

- **D-2（敏感边界）**：压缩摘要落会话树（会话树为未脱敏消息事实域），RunState 只存引用——100% 重建承诺成立。
- **D-4（abort 后会话树写入）**：方案 A——aborted Run 只把已确认部分写入会话树，竞态赢家文本丢弃（详见规格 03）。
