# Workflow 与显式有界 Loop 开发 SOP

## 前置条件

先确认业务负责人、成功标准、验证规则、允许自动修复的范围、权限模式、预算和不可逆副作用。无法确认时先停在设计阶段。

## 执行步骤

1. 画出输入、候选结果、验证结果、修复结果和终态；固定依赖优先使用 Workflow。
2. 把确定性判断写进普通代码、工具或 `passIf`，不要让模型临时发明验收标准。
3. 为 `loop` 配置 `maxIterations`、`maxRepairs`、`maxRepeatedAction`、`onFailure` 和 `onExhausted`。
4. 为所有工具声明副作用、可逆性和目标字段；外部副作用还要有业务幂等键、收据或补偿流程。
5. 先写失败用例，再实现或修改：verify 失败、无进展、耗尽、预算、审批拒绝、超时、中止和瞬态错误都必须有确定终态。
6. 验证每次稳定状态迁移都会持久化；恢复同一 runId 时不重复完整步骤和 committed 副作用。
7. 分别从 CLI/TUI、TypeScript SDK 和 Python SDK 检查相同状态序列与终态。
8. 运行模块测试、黄金示例、覆盖率和 `npm run check:modules`，保存 Trace 与人工结论。

## 必跑命令

```powershell
npx vitest run packages/coremind-runtime/src/loop-controller.test.ts packages/coremind-runtime/src/loop-runner.test.ts packages/coremind-runtime/src/retry-policy.test.ts
npx vitest run examples/golden/golden-examples.test.ts
npm run test:coverage
npm run check:modules
```

## 停止条件

出现未知副作用、业务验证规则不明确、配置指纹不一致、真实凭据缺失、安全门禁失败或工作区外访问时停止。不要通过提高重试次数、切换权限模式或替换 Provider 掩盖问题；未经明确授权也不要提交、推送、打 Tag 或发布。
