# 决策记录 / Decision Log

- 2026-08-09：选择 TypeScript 与本地 mock Provider，以确定性响应覆盖 Loop 状态合同。
- Executor、Verifier 和 Repairer 职责隔离；Verifier 只用可测试的 PASS/FAIL 条件判定。
- 默认 `onFailure: repair`；自动测试另行覆盖 `pause` 与 `loop_exhausted`。
- 示例不使用工具副作用。若业务扩展工具，必须声明 Effect，并补充收据与恢复测试。
- 真实数据字段、生产接口、验证阈值和审批责任不在示例范围内。
