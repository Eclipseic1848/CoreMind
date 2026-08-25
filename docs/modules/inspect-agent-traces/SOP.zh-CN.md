# Trace、RunState 与调试开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先按 runId 定位运行。
2. 按 sequence 重建时间线。
3. 从第一个 fatal error 或 policy_denied 向前检查。
4. 对 Loop 核对状态快照版本、配置指纹和最后稳定 phase。
5. 确认 step_output 完整，committed 副作用不重放，unknown 副作用已转人工核对后再恢复。
6. 用事件证据复现后再修改。
7. 使用假凭据、正文和带敏感查询参数的 URL 验证持久化前脱敏，同时确认普通测试命令仍可供 grader 审计。
8. 保留修复前后 Trace。
9. 对 Replay 使用固定 Facts 与实际 Working Set fixture，核对 Fact、请求与 replay 指纹；任何不一致都按损坏状态处理，禁止回退成近似重放。
10. 对 Telemetry 核对持久配置、生效序列、同 Run consent、feedback 前缀、content 保留目的/撤销方式和受信任 Adapter 的精确 origin 出站收据。收据不是实际 DNS/TLS 认证证据。
11. 运行模块列出的测试，并执行 `npm run check:modules`。
12. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
