# Protocol v2 与 v1 完整迁移周期

Protocol v1 适合当前同步 run/chat 与事件通知，但无法在不继续扩大弱类型边界的情况下稳定承载 RunHandle、断线续订、控制回执和 Projection Query。本决策声明：`0.4.0` 引入 Protocol v2；整个 `0.4.x` 保留 v1 兼容入口，未知协议版本失败关闭。v1 最早到 `0.5.0` 才可考虑移除，且移除需要新的明确决策。

## Status

accepted（2026-08-22）

## Considered Options

- **永久扩展 v1**：被否。同步请求、`unknown` 事件和入口自算状态会继续积累，难以提供可验证的重连与控制语义。
- **`0.4.0` 直接移除 v1**：被否。会无迁移期地破坏现有 Python SDK、CLI/Worker 与第三方客户端。
- **v2 新合同 + v1 兼容 Adapter**（采纳）：Runtime 只保留一套权威语义，两个协议版本通过入口 Adapter 映射；v1 在完整 `0.4.x` 周期可用但不承诺获得全部 v2 能力。

## Consequences

- v2 请求立即返回 RunHandle，并以类型化、带序列的事件 envelope 提供续订、控制与查询。
- CLI、TUI、TypeScript 和 Python 继续共享同一 Node Runtime；协议升级不得产生第二套 Runtime 或入口专属终态算法。
- 版本协商必须显式；未知版本、未知非 ignorable 事件和不合法降级一律拒绝。
- v1 移除不由时间自动触发，最早版本边界是 `0.5.0`，仍需独立授权与迁移证据。
- 详细合同见 [0.4.x Protocol v2 规格](../spec/0.4.x/01-protocol-v2-and-v1-migration.md)。
