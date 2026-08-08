# FAQ/订单助手

根据离线订单数据回答状态问题；订单不存在时明确失败，不得编造。

## 离线运行

1. 在仓库根目录构建：`npm run build:python-worker`。
2. 进入本目录并设置仅用于本地 mock 的环境变量：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. 启动 Provider：`node ../_shared/mock-provider.mjs order 8811`。
4. 另开终端执行：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "查询订单 A-100"`。
5. 执行评测：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。

## 期望证据

输出“订单 A-100 已支付，金额 299 元”，并记录一次 lookup_order 审批与工具调用。

- 配置：[coremind.yaml](coremind.yaml)
- 场景：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[中文](SOP.zh-CN.md)
- 失败与修复：[中文](FAILURES.zh-CN.md)

本示例只使用模拟数据；真实 Provider 配置必须改用 apiKeyEnv，并在获得数据外传授权后再启用。
