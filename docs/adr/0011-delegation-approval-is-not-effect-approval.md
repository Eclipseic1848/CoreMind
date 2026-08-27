# Delegation Approval 不预先批准 Child Run 的 Effect

CoreMind 继续使用 `ask / assisted / full` 三档权限：`ask` 逐次批准委派，`assisted` 只自动批准 Config 明确预批准且满足限制的 Delegation Target，`full` 不逐次询问；显式 deny、预算、路径、网络和凭据边界始终优先。Delegation Approval 只允许创建一个 Child Run，子级后续工具与外部 Effect 仍分别经过统一 ToolPolicy，因为把两层批准合并会隐藏真实副作用和扩大父级授权。
