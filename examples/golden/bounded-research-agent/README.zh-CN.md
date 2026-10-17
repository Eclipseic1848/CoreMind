# 研究/问题调查 Agent

在明确工具、重试、turn、step、token 和超时预算内收集离线证据，并由独立 Reviewer 审查。

## 离线运行

启动 mock Provider 和运行示例要使用两个终端；两个终端都须进入本示例目录，并各自设置 `GOLDEN_MOCK_API_KEY=offline`（PowerShell 用 `$env:GOLDEN_MOCK_API_KEY="offline"`）。

先审查 `coremind.yaml`、`src/search-tool.ts` 及其导入依赖，确认可在宿主权限下加载后，再执行下列带 `--trust-project-code` 的命令。非 TTY 缺少该标志会在导入前拒绝；TTY 也可省略标志并逐次确认。

加载信任与工具权限分开：该标志不免除 `ask` 审批；只有已审查的本地 mock CI 需要跳过工具审批时，才另外加 `--permission full`，后者不能替代加载批准。这里只验证本地 mock，不构成真实 Provider 认证。

1. 在仓库根目录构建：`npm run build:python-worker`。
2. 进入本目录并设置仅用于本地 mock 的环境变量：PowerShell `$env:GOLDEN_MOCK_API_KEY="offline"`；Linux `export GOLDEN_MOCK_API_KEY=offline`。
3. 启动 Provider：`node ../_shared/mock-provider.mjs research 8814`。
4. 另开终端执行：`node ../../../packages/coremind-cli/dist/cli.js run coremind.yaml --prompt "是否应直接用于高影响决策" --trust-project-code`。
5. 执行评测：`node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml --trust-project-code`。

## 期望证据

结论建议小规模试点，引用 S1/S2，保留人工复核和中等置信度。

- 配置：[coremind.yaml](coremind.yaml)
- 场景：[evals/scenarios.yaml](evals/scenarios.yaml)
- SOP：[中文](SOP.zh-CN.md)
- 失败与修复：[中文](FAILURES.zh-CN.md)

本示例只使用模拟数据；真实 Provider 配置必须改用 apiKeyEnv，并在获得数据外传授权后再启用。
