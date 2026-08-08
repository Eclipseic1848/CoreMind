# 参与 CoreMind 开源共建

感谢你愿意帮助 CoreMind 变得更可靠、更容易学习。我们欢迎代码、测试、文档、模板、Provider 认证证据和问题复现。第一次参与开源也完全没关系，本指南会说明从选题到提交的完整路径。

[English](CONTRIBUTING.en.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全策略](SECURITY.md) · [开发文档](docs/index.md)

## 贡献前先确认范围

- Bug 修复：先搜索 Issue；提供最小复现、预期结果和实际结果。
- 新功能：先开 Feature Request，说明用户问题、范围、验收标准和不做什么。
- 安全问题：不要创建公开 Issue，请按[安全策略](SECURITY.md)私下报告。
- 大型架构调整：在编码前等待维护者确认方案，避免双方投入在不同方向。

## 本地环境

- Windows 或 Linux
- Node.js 22.19 或更高版本
- npm 10 或更高版本
- Python 3.10 或更高版本（仅 Python SDK / Wheel 相关改动需要）

```bash
git clone https://github.com/Eclipseic1848/CoreMind.git
cd CoreMind
npm ci
npm run build
npm test
npm run check
```

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `packages/coremind` | TypeScript SDK 统一入口 |
| `packages/coremind-cli` | CLI 与 TUI |
| `packages/coremind-config` | 配置解析、Schema 和校验 |
| `packages/coremind-runtime` | 会话、执行循环、预算、检查点、评测 |
| `packages/coremind-tools` | 内置工具、自定义工具和平台安全层 |
| `packages/coremind-templates` | 模板、脚手架和项目学习材料 |
| `packages/coremind-protocol` | TypeScript / Python 共用协议 |
| `packages/coremind-worker` | Python SDK 使用的本地 Worker |
| `python` | Python SDK 与测试 |
| `docs/modules`、`skills` | 模块合同、SOP、指南和 Skills |

依赖应保持单向。不要让底层包反向依赖 CLI 或统一入口，也不要绕过公开接口引用其他包的源码文件。

## 推荐开发流程

1. 从最新主分支创建聚焦的分支。
2. 为缺陷先写能复现失败的测试；为功能先写可验证的验收测试。
3. 实现满足测试的最小改动，不顺手重构无关代码。
4. 同步更新中英文文档、SOP、Skill、示例和变更记录。
5. 运行与改动相关的测试，再运行完整门禁。
6. 自查 Diff，删除调试日志、临时文件、密钥和本机绝对路径。
7. 创建 Pull Request，并完整填写模板。

## 完整质量门禁

```bash
npm run build
npm run check
npm test
npm run docs:build
npm run release:preflight -- --allow-dirty
```

Python 改动还需要运行：

```bash
python -X utf8 -m unittest discover -s python/tests -v
npm run build:python-worker
python -X utf8 -m build python
```

发布前还会在全新虚拟环境中安装 Wheel，并验证 npm 包内容；本地通过不代表可以跳过 CI。

## 文档与 Skill 规则

- 对话、文档和代码注释使用简体中文；面向最终用户的核心材料同步提供英文。
- 所有文本使用 UTF-8，链接必须可从仓库或文档站访问。
- 新功能模块至少包含双语 README、GUIDE、SOP、Skill、测试入口和 CHANGELOG。
- 说明真实边界：支持清单不等于通过真实服务认证，Checkpoint 不等于回滚所有外部副作用。
- 不在项目文档中泄露内部封装来源、密钥、本机目录或未公开发布信息。

## Provider 认证

适配器可发现不等于认证。提交认证状态前必须按[认证 SOP](docs/providers/CERTIFICATION.zh-CN.md)完成真实流式、工具调用、结构化结果、多轮和错误路径测试，并提供脱敏、可复核的证据。

## 提交与 Pull Request

提交建议使用 `类型: 摘要`，例如 `fix: 修复恢复时重复执行工具`。常用类型包括 `feat`、`fix`、`docs`、`test`、`refactor` 和 `chore`。

Pull Request 应保持单一目的，并说明：

- 解决什么用户问题；
- 哪些内容明确不在范围内；
- 如何验证以及测试结果；
- 是否改变配置、协议、权限、安全或兼容性；
- 是否需要迁移、发布说明或后续工作。

维护者可能要求补充证据或缩小范围。这是为了让公开接口、文档和行为保持一致。提交贡献即表示你同意项目的[行为准则](CODE_OF_CONDUCT.md)，并同意按项目 MIT 许可证发布你的贡献。
