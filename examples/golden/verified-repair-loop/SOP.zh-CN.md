# 验证修复 Loop 开发 SOP

1. 阅读 [需求](docs/requirements.zh-CN.md)与[架构](docs/architecture.zh-CN.md)，确认本示例只验证机制，不代表真实业务规则。
2. 启动离线 mock Provider，确认环境变量仅使用示例值，没有真实密钥或业务数据。
3. 先运行 `coremind check coremind.yaml`，再执行正常场景。
4. 检查状态顺序为 execute → verify → repair → verify → succeeded，并保存 RunOutcome 与 Trace。
5. 把 `onFailure` 改为 `pause` 运行测试，使用同一 runId 恢复，确认 execute 没有重复。
6. 把 `maxRepairs` 改为 `0` 运行测试，确认终态为 `loop_exhausted`，而不是成功。
7. 运行自动测试和评测；只有业务负责人确认后，才能替换数据、规则或 Provider。

停止条件：验证规则未确认、需要工作区外访问、出现未知或不可逆副作用、真实凭据缺失，或者安全门禁失败。
