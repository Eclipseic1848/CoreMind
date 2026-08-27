# Child Run 共享父级 canonical Workspace

`0.7.0` 的 Child Run 只继承父 Run 的 canonical Workspace，Delegation Tool 不接受 cwd、路径根或 worktree 覆盖；父子与兄弟可以并行读取，但写入必须竞争同一个 Workspace Lease。Checkpoint 归属实际写入的 Child Run，父级只接收 change summary；本期不自动创建临时副本、Git worktree 或隔离 Workspace，因为这会引入新的文件所有权、合并和恢复语义。
