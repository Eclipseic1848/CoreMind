# 源码与社区贡献

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

在单向依赖、测试优先、双语材料和发布授权边界内修改 CoreMind 源码。

## 公共接口

- `npm run build`
- `npm test`
- `npm run check`
- `npm run check:modules`
- `npm run docs:build`
- `npm run providers:matrix`
- `npm run release:preflight`

## 错误与边界

- 依赖方向必须保持 config → tools → templates → runtime → facade/CLI/worker
- 不得未经授权 push、tag 或发布
- 不相关用户修改必须保留
- 供应商可发现不等于已认证，正式发布必须有真实证据

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [package.json](../../../package.json)
- [vitest.config.ts](../../../vitest.config.ts)
- [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)
- [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [SECURITY.md](../../../SECURITY.md)
- [docs/.vitepress/config.mts](../../../docs/.vitepress/config.mts)
- [docs/providers/certifications.json](../../../docs/providers/certifications.json)
- [docs/release/README.zh-CN.md](../../../docs/release/README.zh-CN.md)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/check-docs-site.mjs](../../../scripts/check-docs-site.mjs)
- [scripts/clean-package-dist.mjs](../../../scripts/clean-package-dist.mjs)
- [scripts/generate-provider-matrix.mjs](../../../scripts/generate-provider-matrix.mjs)
- [scripts/release-preflight.mjs](../../../scripts/release-preflight.mjs)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/docs-link-policy.test.ts](../../../scripts/docs-link-policy.test.ts)
- [scripts/provider-matrix.test.ts](../../../scripts/provider-matrix.test.ts)
- [scripts/release-preflight.test.ts](../../../scripts/release-preflight.test.ts)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [模块示例](../../../examples/modules/contribute-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/contribute-coremind/README.en.md)
- [Agent Skill](../../../skills/contribute-coremind/SKILL.md)
