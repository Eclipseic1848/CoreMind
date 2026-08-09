# 测试指南

1. `coremind check coremind.yaml`。
2. 运行离线正常场景。
3. 运行 FAILURES 中的暂停恢复与耗尽场景。
4. `node ../../../packages/coremind-cli/dist/cli.js eval coremind.yaml`。
5. 确认退出码、RunOutcome、Loop 状态顺序、Trace、Effect Receipt 与 checkpoint 符合预期。
