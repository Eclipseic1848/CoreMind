# Bounded Research Agent SOP / 研究/问题调查 Agent

1. 阅读 requirements 与 architecture.
2. 启动离线 Provider，确认未使用真实密钥.
3. 先运行 coremind check.
4. 执行正常场景并保存 RunOutcome/Trace.
5. 执行失败场景并确认没有伪成功.
6. 运行自动测试与评测.
7. 由业务负责人确认后再迁移真实数据或 Provider.

停止条件：业务规则未确认、需要工作区外访问、出现不可逆副作用、真实密钥缺失或安全门禁失败。
