# 取消收敛、输入收据与静止

取消路径已统一到 runWithGuard（首次触发者胜出、幂等），但 CoreMind 层不拦截中止后的迟到事件（transcript 可能被竞态赢家文本污染），无输入收据机制，无静止判定，取消相关错误码分散在三处字符串集合。本决策声明：统一取消词汇 Cancel（请求）→ Abort（事实）→ aborted（终态）→ Quiescent（静止）；Abort 生效时刻是事件准入分界点，此后属于旧活动的 assistant/tool 终态事实不得写入 Trace 或 journal；引入 InputReceipt（pending / claimed / discarded / completed）与稳定输入 ID；取消相关错误码收敛为单一码表；取消收敛的验收目标是到达 Quiescent（无在飞活动、无未 flush 写入）。

## Status

accepted

## Considered Options

- **依赖底层 Agent 运行时层拦截**（现状）：被否：该层拦截不完整（transcript 回退泄漏窗口），且 CoreMind 四入口无法就"迟到事件"形成统一语义。
- **全面重写状态机**：被否：LoopController 终态不可逆、DurableOperation 合法迁移表已具备骨架，重写得不偿失。
- **事件准入规则 + 收据 + 静止判定**（采纳）：在事实写入边界（recordEvent / journal append）做准入检查，保留现有状态机。

## Consequences

- 事实分界点语义影响会话树写入：aborted 的 Run 不得把未被确认的完整文本写入 Session 事实（或必须带 abort 标记）。
- 每个外部输入获得稳定 ID 与四态收据；恢复时输入收据参与合法性判定。
- worker 协议可能需扩展（首事件前客户端无法取得 runId 而无法取消）——见规格的未决决策。
- 竞态验收门：1,000 个确定性 cancel/send/timeout/dispose 种子无迟到事实、重复副作用或悬挂（见规格）。
