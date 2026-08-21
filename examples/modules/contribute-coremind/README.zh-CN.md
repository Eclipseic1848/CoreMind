# 源码与社区贡献示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
npm run build
npm run baseline:check
npm run check
npm run test:stability
npm run test:coverage
npm run docs:build
npm run docs:audit
npm run acceptance:rc
npm run release:preflight -- --allow-dirty
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 记录 Windows/Linux 各自结果；未运行的平台不得标记通过。
6. 普通功能分支可用 `npm run release:preflight -- --allow-dirty --defer-provider-certification` 延后当前 Runtime 认证；RC 完整时必须改回严格预检并运行 `npm run acceptance:rc -- --require-manual`，没有同提交的双平台 TTY 与真实 Provider 时不得继续发布。
7. 检查工作流中没有可移动的 Action Tag，Dependabot 升级 PR 也必须通过完整门禁。
8. 如果 `baseline:check` 失败，先判断是回归还是已批准的合同变化；没有迁移、回滚与明确原因时不得更新基线。

返回 [中文指南](../../../docs/modules/contribute-coremind/GUIDE.zh-CN.md)。
