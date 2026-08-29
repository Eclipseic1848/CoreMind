# Child Run 故障与恢复 SOP

1. 记录 ParentRunId、ChildRunId、DelegationId、输入指纹和当前 Fact sequence。
2. 从 `ProjectionEngine.projectTree()` 检查活动、paused、orphaned、joined 与 Lease 状态。
3. 父取消后等待全部子级终止或暂停、关键 Fact flush 和 `parent_joined`；超时不得宣称 Quiescent。
4. orphan 恢复前确认旧 Worker/进程不存在，检查 Workspace lock owner、Effect Receipt 和 Checkpoint。
5. 成功结果仅在执行静止、所有权释放且没有 started/unknown Effect 时默认接受；committed Effect 可以随成功结果接受，但不能据此安全重新委派。其余结果先持久化 Delegation Disposition。
6. 同一指纹只复用原 ChildRunId；不同指纹返回 conflict。unknown/committed Effect 不得靠新建委派重放；安全重委派必须使用新 DelegationId、新预算和 `recoveryOf`。
7. Lease 遗留时按 Workspace Lease 恢复流程显式审计，不删除仍有 Owner 的锁。
8. 运行模块清单中的测试、`npm run check` 与完整仓库门禁。

禁止：跳过 Coordinator 恢复、吞掉取消错误、伪造受控网络能力、把 Projection 当恢复权威、在无 durable Job 所有权时 detach。
