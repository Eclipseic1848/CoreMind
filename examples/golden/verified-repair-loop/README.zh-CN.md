# 验证修复 Loop

先生成候选结果，再由独立验证者判定；失败时有界修复，并演示暂停恢复与耗尽终态。

## 离线运行

1. 在仓库根目录构建：`npm run build:python-worker`。
2. 进入本目录并设置仅用于本地 mock 的环境变量：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. 启动 Provider：`node ../_shared/mock-provider.mjs loop 8815`。
4. 另开终端执行：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "修复候选结果"`。
5. 执行评测：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。

## 期望证据

首次验证返回 FAIL，修复后再次验证返回 PASS，最终输出 candidate-fixed；测试同时验证暂停恢复与耗尽失败。

- 配置：[coremind.yaml](coremind.yaml)
- 场景：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[中文](SOP.zh-CN.md)
- 失败与修复：[中文](FAILURES.zh-CN.md)

本示例只使用模拟数据；真实 Provider 配置必须改用 `apiKeyEnv`，并在获得数据外传授权后再启用。
