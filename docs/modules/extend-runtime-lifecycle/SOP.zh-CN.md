# Runtime 生命周期扩展开发 SOP

## 一、先判断是否需要扩展

1. 配置、Tool API、Workflow、事件订阅能解决时，不创建扩展。
2. 写清楚所需事件、输入字段、输出副作用、失败处理和维护负责人。
3. 如果需要修改审批、Checkpoint、终态或 Provider 内部对象，停止；这些不属于公开扩展面。

## 二、定义能力与信任

1. 使用稳定、小写的扩展 id 和明确版本。
2. 逐项声明 `files`、`process`、`network`、`credentials`、`ui`；没有需要就使用最小值。
3. 宿主代码显式注册扩展，将 id 写入 `trustedIds`，并在 `grants` 中只授予所需能力。
4. 不扫描工作区寻找扩展，不根据文件存在自动信任。

## 三、实现 handler

1. 只处理所需生命周期；payload 视为只读。
2. `before-tool` 只返回 `{ deny: { reason } }` 或不返回决定。
3. Trace exporter 只导出必要字段，禁止记录密钥、完整用户数据或 Provider 私有对象。
4. handler 必须幂等、短时、有界；外部系统失败时由收据暴露，不改变 Runtime 终态。

## 四、失败与安全测试

1. 同步与异步 handler 各测一次。
2. 注入永不完成 Promise，验证 `timed_out` 收据且 Runtime 继续真实收口。
3. 注入异常，验证错误脱敏且不抛回 Runtime。
4. 先让通用权限或人工审批拒绝工具，验证扩展不会执行或改写拒绝。
5. 让通用权限允许，再由扩展拒绝，验证工具未执行且没有 Checkpoint。
6. 验证 `run-finished` 看到 `completed`、`paused` 或 `failed` 的真实 operation。
7. 验证输出中不包含测试密钥或未经授权的凭据字段。

## 五、交付与回滚

1. 运行模块清单中的测试和 `npm run check:modules`。
2. 在 Windows/Linux 分别执行同一交互 Case。
3. 保存扩展版本、grants、超时、Trace 和收据。
4. 回滚时从 `extensions`、`trustedIds` 和 `grants` 同时移除扩展；不删除既有审计证据。
5. 未经明确授权，不提交、推送或发布。
