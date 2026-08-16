# 类型化身份与关联不变量

CoreMind 的全部标识（runId、operationId、checkpointId、eventId 等）是普通 string，receipt 无自有 ID，turn 与消息无类型化 ID，stepId 跨迭代不唯一，idempotencyKey 由字符串拼接且有两处重复实现。本决策声明：为 run / operation / turn / step / call / approval / receipt / checkpoint 引入品牌 ID 类型（编译期防错配），协议边界仍为字符串并做格式校验；EffectReceiptId 定义为规范化 idempotencyKey；确立关联不变量（Call 属于当前 Run/Turn/Step 等）作为可独立执行的运行时检查；StepId 在 Run 内唯一。

## Status

accepted

## Considered Options

- **全面品牌化所有历史 API**：一次把全部 ID 字段改成品牌类型。被否：大面积机械改动，收益与风险不匹配；从协议边界与新字段开始，历史字段渐进迁移。
- **保持普通 string**：被否：错配（跨 Run/Call/Step 传错 ID）无法在编译期发现，只能靠运行时字符串比较，正是本次要消除的风险。
- **品牌 ID + 协议层字符串序列化**（采纳）：类型安全停留在 TS 内部，JSON-RPC/CLI 输出仍为字符串，不破坏四入口与 Python 客户端。

## Consequences

- Turn 引入新身份 TurnId；loop 模板 stepId 增加 occurrence 维度以满足 Run 内唯一。
- 关联不变量（如：receipt 必须能回溯到同一 Run/Step/Call；approval 必须属于发起它的 Run）作为独立检查器存在，可在 debug/eval/release gate 分档开启。
- 合并 idempotencyKey 的两处重复实现（run-effect-coordinator.ts 与 runtime.ts）。
- 0.3.0 持久数据无需迁移：新字段只追加，旧记录按缺省关联处理并显式声明。
