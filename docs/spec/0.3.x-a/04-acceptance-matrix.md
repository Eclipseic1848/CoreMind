# 0.3.x-A 规格：验收设计

> 状态：accepted（2026-08-16 用户确认）
> 验收门定义见 handoff §6.4；本文件把门细化为可执行矩阵

## 1. 请求重建验收（门 A）

**A-1 重建等价性 fixture**

- 固定消息序列 fixture 覆盖：纯文本多轮、工具调用+结果、审批拒绝（not_started）、压缩触发（长历史超阈值）、重试、断流恢复
- 假 Provider 记录"实际发送"的每一条消息；Run 结束后从持久事实重建并逐条比对（内容、顺序、工具 schema、模型路由）
- 断言：**100% 可重建**；有压缩的 fixture 断言重建结果 == 发送值（含摘要替换位置）

**A-2 四入口/双平台等价性**

| 维度 | CLI | TUI | TS SDK | Python SDK |
| --- | --- | --- | --- | --- |
| 规范化请求 | 同 fixture 生成相同规范化请求序列 | ← | ← | ← |
| 终态 outcome | 同一机器码 | ← | ← | ← |
| RunSnapshot | 结构等价（trace/checkpoints/收据一致） | ← | ← | ← |
| 平台 | Windows + Linux 各跑一遍 | ← | ← | ← |

**A-3 历史数据边界**

- 0.3.0 生成的 run 文件（含压缩历史）仍可被恢复读取、不报 corrupt（显式断言）
- 0.3.0 恢复证据不丢失：现有 restore/resume 测试套件全绿

## 2. 身份回溯验收（门 B）

- 每个 ReceiptId 回溯到同一 Run/Step/Call（fixture 全量遍历断言）
- 每个 ApprovalId 在 approval_required/approval_resolved 配对一致（新增端到端断言，现状空白）
- 每个 CheckpointId 回溯到 Run + Call（现状校验升级为断言）
- StepId Run 内唯一性：loop 多次 iteration 的 fixture 断言无重复 StepId
- 不变量检查器（I-1 ~ I-12）在 gate 档对全部 fixture 输出零 violation

## 3. 竞态种子验收（门 C）

**C-1 确定性竞态矩阵**

- PRNG 固定种子生成 1,000 个场景，组合维度：cancel / send（新输入）/ timeout / dispose × 时机（流式进行中、工具执行中、审批挂起中、idle 后）× 次数（单次/多次）
- 每个种子断言四条：无迟到事实（准入计数 = 0 且 trace 无分界点后终态事件）、无孤儿结果（I-7 不变量通过）、无重复副作用（receipt 终态唯一）、无悬挂 Promise（进程退出前 allSettled）
- 失败种子必须可复现（种子号可回放），这是测试失败的调试契约

**C-2 静止指标**

- 本地假 Provider：Cancel → Quiescent p95 < 250ms（100 次采样）
- `quiescence_timeout` 路径注入测试（假 Provider 永不 idle 时，5s 超时记录事件、终态不变）

**C-3 迟到回复拦截**

- 假 Provider 在 abort 生效后 50ms 才完成流式输出 → 断言：transcript 无该文本、会话树无该消息、trace 无 turn 终态事件（方案 A 语义）

## 4. 回归与质量门（门 D）

- 现有测试套件全绿（Windows 492 通过 / 4 跳过基线不下降）
- 新增关键文件逐文件 100% statements/functions/lines/branches：准入规则、输入收据、码表、不变量检查器、TurnId 分配
- 历史关键文件（run-state / runtime / loop-runner / trace / snapshot）覆盖率不下降
- 双语文档同步：新增术语与错误码表同步中英文档（发布前）

## 5. 验收顺序

```
A（重建+入口等价）→ B（身份回溯）→ C（竞态种子）→ D（回归质量门）
```

任一门失败不回退门定义、只修复实现；门定义如需调整必须回到 ADR 修订。

## 6. 非目标（本批不做）

- Web、Jobs、子智能体、第三方插件、远程执行（handoff §6.4）
- checkpoint 原子写入、journal 自愈、并发 run() 串行化（登记 0.3.x-B）
- SQLite / OTel / 新依赖
- 真实 Provider canary（0.3.x-C 批次，需单独授权）
