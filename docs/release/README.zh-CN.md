# CoreMind 正式发布 SOP

本 SOP 把同一提交的 GitHub 源码、8 个 npm 包（含 CLI 与 TypeScript SDK）、PyPI Python SDK、独立源码 ZIP、GitHub Release 和双语文档站作为一个版本发布。任一渠道成功都不能替代整体验收。

> `0.3.0` 已于 2026-08-14 按本 SOP 从提交 `dc6e45489b06f3c28da1934f063fbfbc671c05ef` [正式发布](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.0)。以下步骤继续作为后续版本的发布要求。

[English](README.en.md) · [RC 验收指南](RC-ACCEPTANCE.zh-CN.md) · [已知限制](KNOWN-LIMITATIONS.zh-CN.md) · [0.2→0.3 迁移](../migrations/0.2-to-0.3.zh-CN.md)

## 发布原则

- 版本、提交、Tag、产物清单与公开文档必须一致。
- TypeScript 与 Python 同步发布；Python SDK 继续调用同一个 Node Runtime，不建立第二套运行引擎。
- Release Please 只创建或更新**草稿发布 PR**，不自动 Tag、不自动发布。
- npm 与 PyPI 使用 GitHub OIDC 可信发布；仓库和工作流不得保存长期 Registry Token。
- 外部 GitHub Action 固定到完整提交 SHA，Dependabot 每周创建 Action、npm 和 Python 依赖升级 PR；升级必须通过完整门禁后合并。
- 发布物只构建一次，后续 npm、PyPI、来源证明和 GitHub Release 都下载同一份构建产物。
- 真实 Provider、Windows ConPTY、Linux PTY、双平台 CI、全仓 Markdown 审计任一失败都停止发布。

## 1. 发布账号与环境只配置一次

在正式候选前确认：

1. GitHub 仓库存在受保护环境 `npm` 与 `pypi`，均要求维护者人工批准。
2. 8 个 npm 包分别配置 Trusted Publisher：仓库 `Eclipseic1848/CoreMind`、工作流文件 `publish-pypi.yml`、环境 `npm`。
3. PyPI 项目 `coremind-ai` 配置 Trusted Publisher：同一仓库、同一工作流文件、环境 `pypi`。
4. GitHub Actions 可以写入构建来源证明，并允许发布工作流创建 Release。

工作流文件名和环境名是 OIDC 身份的一部分，不能在发布前随意改名。任何改名都要先同步修改 Registry 端可信发布者配置并重新验证。

## 2. 冻结候选版本

维护者通过 `Prepare Release Pull Request` 工作流输入目标版本，例如 `0.3.0`。Release Please 创建草稿 PR 后，维护者在该 PR 中执行版本同步：

```powershell
npm run release:sync-version -- 0.3.0
```

版本同步器会统一根清单、8 个公开 npm 包、内部精确依赖、`package-lock.json`、Python PEP 440 版本和 `coremind.__version__`。随后人工同步中英文 CHANGELOG、README、迁移说明、Provider 状态、第三方声明与路线图。

版本检查：

```powershell
npm run release:preflight -- --allow-dirty
```

草稿 PR 未通过全部检查前不得标记 ready；不得从普通功能分支直接创建发布 Tag。

## 3. 执行代码与文档门禁

```powershell
npm ci
npm run build
npm run check
npm run test:stability
npm run test:coverage
npm run docs:build
npm run docs:audit
npm run security:audit
npm run acceptance:rc
```

必须记录真实数字，而不是只写“测试通过”：测试文件/Case 数、条件跳过原因、覆盖率基线与目标差距、Python 测试、模块合同、黄金示例和依赖审计结果。

属性测试必须使用仓库固定种子，受宿主能力影响的探测必须通过可注入依赖构造确定性用例；同一提交在重复执行或不同 Runner 上出现覆盖率漂移时，先修复测试不确定性，不得直接降低基线。

`docs:audit` 检查仓库维护的全部 Markdown 是否为严格 UTF-8、本地链接是否存在，以及文档标识边界是否合规。依赖、缓存、构建和覆盖率目录不属于项目文档，不进入扫描。

## 4. 完成 RC 人工与真实服务验收

严格按 [RC 验收指南](RC-ACCEPTANCE.zh-CN.md)执行：

- P01～P19 自动矩阵与逐 Case 测试锚点全部通过。
- Windows 和 Linux 各有一份真实伪终端 P20 证据，且绑定同一版本与候选提交。
- P20 实际 JSON 保存在不进入 Git 的 `.scratch/rc-evidence/`，并与工作流运行号一起归档；候选源码只保留模板，避免证据 SHA 自引用。
- 至少一个已批准 Provider 完成本次真实流式、工具、结构化、多轮和错误路径复验。
- Linux 自动化必须由目标平台 PTY 运行；Windows、管道输入或普通日志不能伪造成 Linux 真实终端。

最终确认命令：

```powershell
npm run acceptance:rc -- --require-manual
```

## 5. 合并候选并创建 Tag

1. 最终全仓 Markdown 审计通过后，将草稿发布 PR 标记 ready。
2. 确认 PR 只包含本版本内容，双平台 CI 全绿后合并到 `main`。
3. 在合并提交上创建受保护 Tag `v<版本>`；Tag 必须与根 `package.json` 版本完全一致。
4. Tag 后工作区必须干净，重新执行 `npm run release:preflight`。

Tag 不触发自动发布。维护者仍需在 GitHub Actions 中手动运行 `Publish CoreMind Release` 并输入已存在的 Tag。

## 6. 一次构建、可信发布与来源证明

统一发布工作流执行以下固定顺序：

1. 从指定 Tag checkout，同一作业完成代码、安全和发布预检。
2. 构建 8 个 npm tarball、1 个 wheel、1 个独立源码 ZIP。
3. 对 npm 执行 allowlist、publint、类型解析；对 wheel 执行 Twine、干净安装和内置 Worker；对源码 ZIP 使用跨平台解码器执行内容、路径穿越和解压安装门禁。
4. 生成 `release-manifest.json` 与 `SHA256SUMS.txt`，每个产物记录版本、大小和 SHA-256。
5. 上传一次构建产物；每个消费作业都在使用前独立校验 `SHA256SUMS.txt`，再由独立作业生成 GitHub 构建来源证明。
6. 受保护 `npm` 环境批准后，以 OIDC 按依赖顺序发布 8 个精确 tarball。预发布版本使用 `next`，稳定版本使用 `latest`。
7. 受保护 `pypi` 环境批准后，以 OIDC 发布同一个 wheel。
8. npm、PyPI 与来源证明都成功后，创建 GitHub Release，只附当前独立源码 ZIP、校验文件和清单。GitHub 自动生成的 zip/tar.gz 源码入口无法删除，不应与独立源码包混淆。
9. Release 创建成功后，发布工作流使用 `workflow_dispatch` 从 `main` 显式派发双语文档部署。`docs.yml` 的 Release 事件入口只作为维护者手动创建 Release 时的回退，不依赖工作流令牌生成的 Release 事件再次触发。

发布支持安全断点续传：npm、PyPI 或 GitHub Release 已存在的同名同版本资产只有在哈希一致时才跳过；缺失资产继续上传，哈希冲突立即失败。发布版本不可覆盖，冲突时必须修复并使用更高版本。

## 7. 发布后公共 Registry 验证

在未使用仓库 `node_modules` 的全新目录执行：

```powershell
npm install -g coremind-cli@0.3.0
coremind --version
coremind create acceptance-agent --template blog-writer --language typescript --provider alibaba-model-studio
cd acceptance-agent
coremind check coremind.yaml
```

另建全新 Python 虚拟环境，从 PyPI 安装目标版本，验证 `coremind.__version__`、Node Worker 启动、一次 TypeScript/Python parity 和 Python callable 工具往返。最后检查 GitHub Release 哈希、双语文档站导航、下载链接与版本说明。

## 8. 失败、停止与恢复

- 构建、验收、OIDC、Registry、来源证明或 Release 任一步失败，立即停止后续步骤。
- npm/PyPI 已发布产物不得覆盖：npm 使用 deprecate，PyPI 必要时撤回，并发布更高修复版本。
- Registry 成功但 GitHub Release 失败时，不得重新构建；必须复用已保存的同一产物恢复。
- Provider 权限或账号服务未开通时，恢复账号授权后重跑原认证对象；未经批准不得换模型或 Provider。
- 泄露凭据时先撤销，再清理证据和通知维护者；不得仅删除日志后继续发布。

发布完成后更新 CHANGELOG、README、路线图、Provider 证据、公开发布记录和维护者内部交接记录（如适用），并从公共 Registry 再验证一次版本一致性。
