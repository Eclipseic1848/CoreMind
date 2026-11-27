# CoreMind（星枢智核）

[English](README.en.md) · [中文文档](https://eclipseic1848.github.io/CoreMind/) · [快速开始](docs/guide/01-quickstart.md) · [最新发布](https://github.com/Eclipseic1848/CoreMind/releases/latest)

CoreMind 是面向业务项目的智能体框架。你可以先用一个模型和一份 `coremind.yaml` 跑通任务，再按需接入知识检索、Hindsight 记忆、Skill、工具或本体。CLI/TUI、TypeScript SDK 和 Python 同步、异步 SDK 共用同一个 Node.js Runtime，执行相同的权限、预算和恢复规则。

## 快速开始

在 Windows 或 Linux 上安装 Node.js 22.19 或更高版本。下面用公开 CLI 创建一个只有 `coremind.yaml` 的项目：

```sh
npx --yes coremind-cli@2.2.0 create my-agent --runtime-only --provider deepseek --model deepseek-flash
cd my-agent
```

在当前终端设置环境变量 `DEEPSEEK_API_KEY`，然后运行下面的命令。它会向 DeepSeek Flash 发送一条提示。想先离线试用，可运行使用本地模拟服务的[五个示例](examples/golden/README.zh-CN.md)。

```sh
npx --yes coremind-cli@2.2.0 run coremind.yaml --prompt "请只回答 OK"
```

| 在已有应用中使用 | 安装与示例 |
| --- | --- |
| TypeScript | `npm install --save-exact coremind-ai@2.2.0`，从 [TypeScript 最小示例](examples/modules/configure-coremind/runtime-only.mts)调用 Runtime。 |
| Python 3.10 及以上 | `python -m pip install coremind-ai==2.2.0`，用 [Python 最小示例](examples/modules/configure-coremind/runtime_only.py)运行同步或异步调用。安装包自带 Worker，运行时仍需 Node.js。 |

## 选择需要的能力

| 业务需要 | 从哪里开始 |
| --- | --- |
| 从资料中给出带出处的答案 | [知识服务](examples/modules/manage-knowledge/README.zh-CN.md)支持资料导入、检索、引文回查及撤回。 |
| 让智能体记住已确认的信息 | [Hindsight 记忆](examples/modules/manage-memory/README.zh-CN.md)支持保存、召回、更正及遗忘。 |
| 教智能体按团队流程办事 | [Skill](docs/guide/03-skills.md)可固定版本并按需加载。[工具](docs/modules/build-tools/GUIDE.zh-CN.md)接入业务系统，受权限和预算约束。 |
| 根据业务对象、关系与约束执行动作 | [本体服务](examples/modules/manage-ontology/README.zh-CN.md)支持对象映射、约束校验、动作回执及对账。 |
| 编排多步任务、排查运行结果 | [工作流](docs/modules/design-workflows/GUIDE.zh-CN.md)组合顺序、并行、条件或验证修复步骤。[持久任务](docs/guides/durable-tasks.zh-CN.md)保存进度，[Trace](docs/modules/inspect-agent-traces/GUIDE.zh-CN.md)记录执行过程。 |

知识、记忆和本体由独立的 MCP 服务提供，可分别安装、部署和升级。2.2.0 配套的三个 PyPI 包均为 0.1.1。[按需加载指南](docs/guide/06-capability-construction.md) · [独立部署与恢复](examples/optional-components/README.zh-CN.md)

## 当前稳定版 2.2.0

本版修复工作流多行条件与空字符串分支，改进持久任务错误提示、Python Worker 关闭与审批处理，以及知识、记忆、本体服务的长任务处理。[发布说明与制品](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.2.0) · [2.1 升级与回退](docs/migrations/2.1-to-2.2.zh-CN.md) · [变更历史](CHANGELOG.md)

- **公开安装**　CLI、TypeScript 与 Python SDK 为 2.2.0。发布流程已从 GitHub、npm 和 PyPI 下载并验证制品。[npm CLI](https://www.npmjs.com/package/coremind-cli/v/2.2.0) · [PyPI SDK](https://pypi.org/project/coremind-ai/2.2.0/) · [公开回装记录](https://github.com/Eclipseic1848/CoreMind/actions/runs/45952019764)
- **模型验证**　`deepseek-flash` 在本版通过 12 项真实 API 检查。其他模型的接入和认证状态可在供应商矩阵中按版本查询。[认证结果](https://github.com/Eclipseic1848/CoreMind/actions/runs/45939479096) · [供应商矩阵](docs/providers/README.zh-CN.md)
- **业务评测**　查看固定样例、独立判定方法，以及公开模型在哪些任务上仍然失败。[泛化评测报告](examples/modules/evaluate-agents/GENERALIZATION.zh-CN.md) · [已知限制](docs/release/KNOWN-LIMITATIONS.zh-CN.md)

## 文档与社区

[CLI 指南](docs/guide/05-cli-usage.md) · [配置指南](docs/guide/02-configuration.md) · [功能模块](docs/modules/README.zh-CN.md) · [SOP 与 Skill 索引](docs/modules/SOP-SKILL-INDEX.zh-CN.md) · [公开路线图](docs/roadmap.zh-CN.md)

[参与贡献](CONTRIBUTING.md) · [社区行为准则](CODE_OF_CONDUCT.md) · [安全策略与漏洞报告](SECURITY.md)

CoreMind 采用 [MIT 许可证](LICENSE)。依赖与第三方组件的许可证声明见[第三方声明](THIRD_PARTY_NOTICES.md)。
