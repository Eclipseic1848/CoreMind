# 数据分析 Agent

通过 Python SDK 注册 callable 工具，确定性汇总 CSV，并把文件结果写入工作区。

## 离线运行

1. 在仓库根目录构建：`npm run build:python-worker`。
2. 进入本目录并设置仅用于本地 mock 的环境变量：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. 启动 Provider：`node ../_shared/mock-provider.mjs data 8813`。
4. 另开终端执行：`python src/main.py`。
5. 执行评测：`python -m unittest discover -s tests -p "test_*.py"`。

## 期望证据

返回 rows=3、total=300，并在 artifacts/summary.json 写入华东与华南汇总。

- 配置：[coremind.yaml](coremind.yaml)
- 场景：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[中文](SOP.zh-CN.md)
- 失败与修复：[中文](FAILURES.zh-CN.md)

本示例只使用模拟数据；真实 Provider 配置必须改用 apiKeyEnv，并在获得数据外传授权后再启用。
