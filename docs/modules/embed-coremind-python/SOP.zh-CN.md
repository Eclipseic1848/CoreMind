# Python SDK 与工具桥开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 创建并复用一个客户端。
2. 先 initialize，再注册 Python 工具。
3. 为 callable 注解参数类型，并填写真实 `effect.operations` 与 `effect.reversible`。
4. 订阅事件和处理审批，穷举消费六种 RunOutcome 终态。
5. 仅用 resume_run 恢复暂停或意外中断且安全的运行。
6. 显式 Loop 必须与 TypeScript 对比状态顺序、暂停恢复、耗尽和 Effect Receipt。
7. 注入一次工具注册失败，确认客户端自动终止半启动 worker；正常流程仍在 finally 或上下文管理器中关闭 worker。
8. 运行模块列出的测试，并执行 `npm run check:modules`。
9. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
