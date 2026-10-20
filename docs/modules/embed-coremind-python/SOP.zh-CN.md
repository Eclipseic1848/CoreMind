# Python SDK 与工具桥开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 创建并复用一个客户端。
2. 默认 Protocol v1 先 initialize，再注册 Python 工具；Protocol v2 显式协商，不注册 Python callable。
3. 使用 v1 callable 时注解参数类型，并填写真实 `effect.operations` 与 `effect.reversible`。验证 future/字符串 `int`、`str`、`bool` 和已有容器注解的自动 Schema，确认 Node 先按既有规则转换，再校验 Schema，转换后仍未通过的参数在执行前拒绝；无法解析的前向引用须明确要求显式 `parameters`，原显式 Schema 保持兼容。复杂 typing 不超出既有支持范围。
4. 订阅事件和处理审批；v1 结果穷举消费六种 RunOutcome，v2 用 `query(runId)` 读取最终 Projection。对已接受的 v2 Run 分别注入已登记启动错误与未知异常，核对 `query`/`events` 的持久结果保留共享分类的稳定错误码、对应终态和安全消息；未知 `unclassified_error` 须暂停并要求人工审计，不暴露凭据或原始堆栈。
5. 仅用 resume_run 恢复暂停或意外中断且安全的运行。
6. 显式 Loop 必须与 TypeScript 对比状态顺序、暂停恢复、耗尽和 Effect Receipt；宿主验收还要核对请求身份、候选摘要、持久决定和最终 Projection outcome。
7. 对 v1 工具桥注入注册失败，确认客户端自动终止半启动 worker；正常流程仍在 finally 或上下文管理器中关闭 worker。
8. 对比 v1 返回的 snapshot 与 TypeScript 同结构样本；逐层篡改 operation、outcome、metrics、Trace、Checkpoint 与 Artifact 时必须稳定报 `invalid_run_snapshot`。
9. 运行模块列出的测试，并执行 `npm run check:modules`。
10. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
