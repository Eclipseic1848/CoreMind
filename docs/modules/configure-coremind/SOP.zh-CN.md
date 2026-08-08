# 配置与 Schema开发 SOP

## 前置条件

先阅读 [模块说明](README.zh-CN.md)，确认业务负责人、输入输出、失败条件和权限边界。

## 执行步骤

1. 先写 schemaVersion、name 和 agents。
2. 显式选择 runtime、permissions 和 quality。
3. 运行 coremind check，再处理全部错误与告警。
4. 业务字段不明确时停止并询问负责人。
5. 运行模块列出的测试，并执行 `npm run check:modules`。
6. 保存 Trace、评测和人工确认记录；未经明确授权不发布。

## 停止条件

遇到未确认业务规则、不可逆副作用、工作区外访问、真实密钥缺失或安全门禁失败时停止，向负责人请求决定。不要自行扩大业务范围。
