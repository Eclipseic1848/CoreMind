# 源码与社区贡献上手指南

## 什么时候使用

在冻结公开合同、单向依赖、测试优先、双语材料和发布授权边界内修改 CoreMind 源码。

## 最小示例

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

普通功能分支 CI 因 Runtime 改动尚未进入发布候选认证时，可使用 `npm run release:preflight -- --allow-dirty --defer-provider-certification`。看到延后警告只代表开发门禁通过；正式候选必须移除该选项并完成真实 Provider 复验。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/contribute-coremind/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 正式候选必须在 Windows 与 Linux 各三连跑；没有的平台证据保持待验收，不用其他平台结果代替。覆盖率基线使用各平台实测值，通用回退必须等于两平台的逐项最小值。
6. 按 [RC 验收指南](../../release/RC-ACCEPTANCE.zh-CN.md)保存双平台真实伪终端与真实 Provider 证据；发布物必须来自同一干净 Tag。
7. Release Please 只准备草稿发布 PR；OIDC 受保护环境批准后，统一工作流才发布 npm、PyPI、来源证明和 GitHub Release。
8. 外部 Action 只接受已核对的完整 SHA；Dependabot 升级 PR 必须重跑同一组门禁。每个发布物作业在使用前独立校验 SHA-256。
9. 发布前核对 npm、Python 构建与上传工具仍可从官方 Registry 获取且未被撤回；工具版本变化后重跑工作流合同、wheel 和完整发布物门禁。

## 冻结基线如何使用

- `baseline:check` 从正式构建产物重新生成 8 个公开包的类型摘要，并核对 Config/Protocol Schema、关键依赖组合、P01～P20、双平台行为、同题编码评测合同和覆盖率下限。
- 当前开发提交、采集时间、平台和构建哈希只用于追溯，不会造成误报；Release Tag 指向与 Release Manifest 摘要属于阻断合同。覆盖率可以提高，不能下降。
- `baseline:update` 不是修复失败的捷径。只有经过批准的合同变化，且迁移、兼容和回滚已写清楚时，才允许带明确原因执行。
- 真实外部编码对照当前保持 `not-run`；它涉及模型费用、隐私和样例代码外发，必须另行授权。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要把覆盖率目标写成已达成；当前门禁以真实基线阻止下降，并明确列出到 80%/90% 目标的差距。
- 不要把 Release Please PR、历史 Provider 证据或单个平台 TTY 当成发布完成。
- 不要通过重写基线掩盖公开接口、依赖或行为回归。
