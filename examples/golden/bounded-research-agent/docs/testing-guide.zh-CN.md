# 测试指南

先审查 `coremind.yaml`、`src/search-tool.ts` 及其导入依赖，确认可在宿主权限下加载后，再执行下列带 `--trust-project-code` 的命令。非 TTY 缺少该标志会在导入前拒绝；TTY 也可省略标志并逐次确认。

加载信任与工具权限分开：该标志不免除 `ask` 审批；只有已审查的本地 mock CI 需要跳过工具审批时，才另外加 `--permission full`，后者不能替代加载批准。这里只验证本地 mock，不构成真实 Provider 认证。

1. `coremind check coremind.yaml`。
2. 运行离线正常场景。
3. 运行 FAILURES 中的至少一个失败场景。
4. `node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml --trust-project-code`。
5. 确认退出码、RunOutcome、工具计数、审批、Trace 与 checkpoint 符合预期。
