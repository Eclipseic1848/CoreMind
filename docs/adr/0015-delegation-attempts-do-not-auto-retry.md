# Delegation Attempt 不自动重试

一个 DelegationId 永久对应一次 Child Run 创建尝试，相同输入只幂等返回原 ChildRunId，不再次执行；只有 RecoveryDisposition 明确允许安全重放时，父级才能在记录 Delegation Disposition 后用新的 DelegationId 和新预算建立关联尝试。committed/unknown Effect、orphan 或执行所有权不明必须暂停等待人工协调，因为复用身份或自动重试会掩盖实际执行次数并可能重复副作用。
