# 合同审核 Agent

按条款提取、风险审核、结构化输出三步生成必须人工复核的合同风险报告。

## 离线运行

1. 在仓库根目录构建：`npm run build:python-worker`。
2. 进入本目录并设置仅用于本地 mock 的环境变量：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. 启动 Provider：`node ../_shared/mock-provider.mjs contract 8812`。
4. 另开终端执行：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "服务费用30天支付，未约定责任上限"`。
5. 执行评测：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。

## 期望证据

最终 JSON 的 riskLevel 为 high，requiresHumanReview 为 true。

- 配置：[coremind.yaml](coremind.yaml)
- 场景：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[中文](SOP.zh-CN.md)
- 失败与修复：[中文](FAILURES.zh-CN.md)

本示例只使用模拟数据；真实 Provider 配置必须改用 apiKeyEnv，并在获得数据外传授权后再启用。
