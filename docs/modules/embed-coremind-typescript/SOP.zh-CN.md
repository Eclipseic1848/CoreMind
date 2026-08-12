# TypeScript SDK 开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 只从 coremind-ai 导入公共接口。
2. 用 parseAndValidate 校验外部配置。
3. 为每个 defineTool 工具填写 JSON Schema、`effect`，再注入审批处理器。
4. 穷举消费 RunOutcome 六种终态与结构化事件；不要只处理成功与异常。
5. 显式 Loop 必须验证状态顺序、暂停恢复、耗尽、超时、中止和 Effect Receipt。
6. 不要依赖 packages 内部路径。
7. 跨进程、跨语言或持久化时只传递 `RunResult.snapshot`；完整校验 operation、outcome、metrics、evaluation、Trace、Checkpoint、Artifact 与扩展收据。
8. 运行模块列出的测试，并执行 `npm run check:modules`。
9. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
