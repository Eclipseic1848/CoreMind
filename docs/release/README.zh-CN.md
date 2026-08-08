# CoreMind 正式发布 SOP

本流程用于把同一稳定等级的源码、GitHub Release、npm 包、PyPI 包和文档站作为一个版本发布。任何单项成功都不能替代整体验收。

## 发布原则

- 发布必须由维护者明确批准；通过预检不等于授权发布。
- TypeScript 与 Python SDK 同步建设、同步发布，并保持同一运行语义。
- npm 包使用同一版本，内部依赖使用精确版本。
- 运行时依赖审计与文档开发工具审计分别记录，阻断项不得隐藏。
- 发布证据来自全新环境和真实平台，不来自已有 `node_modules` 的偶然状态。

## 1. 冻结候选版本

1. 确认范围、版本号、发布日期和发布负责人。
2. 清空未决的安全、协议、权限和数据外发决策。
3. 同步所有 npm 包版本与 Python PEP 440 版本。
4. 更新 CHANGELOG、README、迁移说明、供应商矩阵和第三方声明。
5. 确认 Git 工作区只包含本次版本改动。

## 2. 执行质量门禁

```bash
npm ci
npm run build
npm run check
npm test
npm run docs:build
npm run release:preflight
npm audit --omit=dev
npm audit
```

随后在 Windows 与 Linux 的全新环境中完成 CLI 安装、TUI 人工交互、TypeScript SDK、Python SDK、恢复、安全边界和至少一个真实认证供应商验收。macOS 当前仅记录为未支持，不计入一期通过平台。

## 3. 验证发布产物

```bash
npm publish --dry-run --workspaces --if-present --json
npm run build:python-worker
python -X utf8 -m build python
python -X utf8 -m twine check python/dist/*
python -X utf8 scripts/check-python-wheel.py python/dist/*.whl
```

将 Wheel 安装到全新虚拟环境，执行导入、同步/异步客户端、真实 Worker 和黄金样例。检查 npm Tarball 与 Wheel 不含测试缓存、密钥、环境文件、本机路径或源码外的意外文件。

## 4. 人工批准点

发布负责人应提供一份候选报告，列出：版本、Commit、平台结果、测试数量、真实供应商证据、依赖审计、已知限制、产物校验和回滚方案。只有获得明确“发布”批准后才能继续。

## 5. 发布顺序

1. 按依赖顺序发布 npm 底层包、统一 SDK、Worker 和 CLI。
2. 从公共 Registry 全新安装并做冒烟测试。
3. 发布 PyPI 包并从 PyPI 全新安装验证。
4. 创建签名或受保护的 Git 标签和 GitHub Release，附校验信息与已知限制。
5. 发布同版本文档站，并验证中英文导航、下载链接和版本说明。
6. 将预发布标签切换到目标分发标签；不要在产物验证前把版本标为稳定。

## 6. 失败与回滚

任一渠道失败时立即停止后续步骤。npm 已发布版本通常不可覆盖，应废弃错误版本并发布修复版本；PyPI 产物不可替换，应撤回有问题版本并发布新版本；GitHub 和文档必须明确标记状态。密钥泄露时先撤销密钥，再清理记录和通知受影响方。

发布结束后保存完整证据并更新 `handoff.md`。没有 Windows/Linux 验收、真实供应商证据或安全门禁通过时，一期仍不能标记为正式完成。
