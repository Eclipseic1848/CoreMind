# 源码与社区贡献

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

在单向依赖、测试优先、双语材料和发布授权边界内修改 CoreMind 源码，并用可重复门禁证明同一提交的源码、npm 包、Python wheel、独立源码 ZIP 与文档站一致。

## 公共接口

- `npm run build`
- `npm test`
- `npm run check`
- `npm run check:modules`
- `npm run docs:build`
- `npm run docs:audit`
- `npm run test:stability`
- `npm run test:coverage`
- `npm run release:check-npm`
- `npm run release:test-npm`
- `npm run release:test-source`
- `npm run release:check-wheel`
- `npm run providers:matrix`
- `npm run release:preflight`
- `npm run release:sync-version -- <semver>`
- `npm run acceptance:rc`
- `npm run release:bundle -- --tag <tag>`

## 错误与边界

- 依赖方向必须保持 config → tools → templates → runtime → facade/CLI/worker
- 不得未经授权 push、tag 或发布
- 不相关用户修改必须保留
- 供应商可发现不等于已认证，正式发布必须有真实证据
- 单次测试通过不能替代 Windows/Linux 三连跑；覆盖率低于目标时必须记录真实基线且只允许上升
- 发布物必须通过文件 allowlist、类型解析、干净安装和内置 Worker 启动验证
- Release Please 只创建草稿发布 PR；Tag 与正式发布仍由维护者批准
- 外部 Action 固定完整提交 SHA，交由 Dependabot 提出可审查的升级 PR
- npm/PyPI 可信发布身份绑定工作流文件和受保护环境，任一身份不匹配都停止发布
- 发布物必须来自同一干净 Tag，并保存 SHA-256、产物清单和构建来源证明

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [package.json](../../../package.json)
- [vitest.config.ts](../../../vitest.config.ts)
- [.github/workflows/ci.yml](../../../.github/workflows/ci.yml)
- [.github/workflows/docs.yml](../../../.github/workflows/docs.yml)
- [.github/workflows/release-please.yml](../../../.github/workflows/release-please.yml)
- [.github/workflows/publish-pypi.yml](../../../.github/workflows/publish-pypi.yml)
- [.github/dependabot.yml](../../../.github/dependabot.yml)
- [.release-please-manifest.json](../../../.release-please-manifest.json)
- [release-please-config.json](../../../release-please-config.json)
- [CONTRIBUTING.md](../../../CONTRIBUTING.md)
- [SECURITY.md](../../../SECURITY.md)
- [docs/.vitepress/config.mts](../../../docs/.vitepress/config.mts)
- [docs/providers/certifications.json](../../../docs/providers/certifications.json)
- [docs/release/README.zh-CN.md](../../../docs/release/README.zh-CN.md)
- [docs/release/RC-ACCEPTANCE.zh-CN.md](../../../docs/release/RC-ACCEPTANCE.zh-CN.md)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/check-docs-site.mjs](../../../scripts/check-docs-site.mjs)
- [scripts/clean-package-dist.mjs](../../../scripts/clean-package-dist.mjs)
- [scripts/generate-provider-matrix.mjs](../../../scripts/generate-provider-matrix.mjs)
- [scripts/release-preflight.mjs](../../../scripts/release-preflight.mjs)
- [scripts/package-artifacts.mjs](../../../scripts/package-artifacts.mjs)
- [scripts/validate-npm-tarballs.mjs](../../../scripts/validate-npm-tarballs.mjs)
- [scripts/validate-source-archive.mjs](../../../scripts/validate-source-archive.mjs)
- [scripts/check-python-wheel.py](../../../scripts/check-python-wheel.py)
- [scripts/test-stability.mjs](../../../scripts/test-stability.mjs)
- [scripts/check-coverage.mjs](../../../scripts/check-coverage.mjs)
- [scripts/coverage-baseline.json](../../../scripts/coverage-baseline.json)
- [scripts/release-version.mjs](../../../scripts/release-version.mjs)
- [scripts/release-artifacts.mjs](../../../scripts/release-artifacts.mjs)
- [scripts/publish-npm-artifacts.mjs](../../../scripts/publish-npm-artifacts.mjs)
- [scripts/rc-acceptance.mjs](../../../scripts/rc-acceptance.mjs)
- [scripts/audit-markdown.mjs](../../../scripts/audit-markdown.mjs)
- [scripts/markdown-audit-lib.mjs](../../../scripts/markdown-audit-lib.mjs)
- [scripts/check-module-contract.mjs](../../../scripts/check-module-contract.mjs)
- [scripts/docs-link-policy.test.ts](../../../scripts/docs-link-policy.test.ts)
- [scripts/provider-matrix.test.ts](../../../scripts/provider-matrix.test.ts)
- [scripts/release-preflight.test.ts](../../../scripts/release-preflight.test.ts)
- [scripts/package-artifacts.test.ts](../../../scripts/package-artifacts.test.ts)
- [scripts/coverage-baseline.test.ts](../../../scripts/coverage-baseline.test.ts)
- [scripts/workflow-contract.test.ts](../../../scripts/workflow-contract.test.ts)
- [scripts/source-archive.test.ts](../../../scripts/source-archive.test.ts)
- [scripts/release-version.test.ts](../../../scripts/release-version.test.ts)
- [scripts/release-artifacts.test.ts](../../../scripts/release-artifacts.test.ts)
- [scripts/publish-npm-artifacts.test.ts](../../../scripts/publish-npm-artifacts.test.ts)
- [scripts/rc-acceptance.test.ts](../../../scripts/rc-acceptance.test.ts)
- [scripts/markdown-audit.test.ts](../../../scripts/markdown-audit.test.ts)
- [python/tests/test_release_metadata.py](../../../python/tests/test_release_metadata.py)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [模块示例](../../../examples/modules/contribute-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/contribute-coremind/README.en.md)
- [Agent Skill](../../../skills/contribute-coremind/SKILL.md)
