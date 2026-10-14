# TypeScript SDK 开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 只从 coremind-ai 导入公共接口。
2. 用 parseAndValidate 校验外部配置。
3. 为每个 defineTool 工具填写 JSON Schema、`effect`，再注入审批处理器。
4. 穷举消费 RunOutcome 六种终态与结构化事件；不要只处理成功与异常。
5. 显式 Loop 必须验证状态顺序、暂停恢复、耗尽、超时、中止和 Effect Receipt；宿主验收还需验证候选身份、持久回复及最终 outcome。
6. 不要依赖 packages 内部路径。
7. 跨进程、跨语言或持久化时只传递 `RunResult.snapshot`；完整校验 operation、outcome、metrics、evaluation、Trace、Checkpoint、Artifact 与扩展收据。
8. 运行模块列出的测试，并执行 `npm run check:modules`。
9. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

1.1 开发线使用运行控制时，先确认活动 Run 已就绪，保留 controlId，必要时固定预期 runId，再调用 `ChatSession.steer/followUp`。核对五态控制回执与独立输入消费/丢弃事件；注入 accepted/applied 提交失败、终态竞争和冷恢复，确认不误投下一轮、不自动重投消费未确认的 applied 控制，也不扩大权限。普通 Session、首输入与副作用恢复门保持不变；不要把 applied 当作已消费或声称崩溃窗口消失。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
