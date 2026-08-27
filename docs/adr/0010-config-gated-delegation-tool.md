# Config 门控的 Delegation Tool 是唯一产品发起路径

CoreMind 只允许活动父 Run 通过 Config v2 明确启用的 Delegation Tool 创建 Child Run，因为独立 CLI spawn 或入口专属创建逻辑会绕过父级身份、预算、权限、Context、Workspace Lease 和取消链。CLI、TUI、TypeScript 与 Python 只配置、运行、观察和控制同一 Runtime 语义；底层 `delegateChildRun()` 不作为面向配置驱动用户的主要入口。

## Consequences

委派默认禁用。Config 预先声明命名 Agent，并为每个父 Agent 配置允许的 Delegation Target；单次委派只提供任务和进一步收紧的预算或限制，不能内联增加 Agent、模型、工具、权限、路径、网络或凭据范围。
