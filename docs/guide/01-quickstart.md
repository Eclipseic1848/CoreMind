# 快速上手

5 分钟跑通第一个智能体。目标读者：会写代码、但第一次接触智能体开发的工程师。

## 1. 安装

需要 Node.js ≥ 22.19.0。

本指南使用 npm 上的 `coremind-cli@2.2.0`。已有项目可参考[2.1→2.2 迁移与回退](../migrations/2.1-to-2.2.zh-CN.md)。从更早版本升级时，可查看[1.4→2.0 迁移指南](../migrations/1.4-to-2.0.zh-CN.md)和[1.0.1→1.2 历史迁移指南](../migrations/1.0-to-1.2.zh-CN.md)。

```bash
npm install -g coremind-cli@2.2.0
coremind --version              # 应显示 coremind v2.2.0
coremind --help                 # 查看帮助
```

## 2. 选择项目入口

在已有业务项目或空目录中，可直接使用[仅运行 Runtime 的最小配置](06-capability-construction.md)，按需再开一项能力。下面用翻译模板演示 CLI 创建项目。

```bash
coremind providers
coremind create my-agent --template translator --language typescript --provider deepseek --model deepseek-flash
cd my-agent
```

看一下生成的 `coremind.yaml`——这是智能体定义。项目还会生成测试/评测骨架、双语需求与架构、开发 SOP、验收清单、项目 Skill 和 checkpoint 目录；已有文件不会覆盖。

## 3. 配置 API key

```powershell
Copy-Item .env.example .env     # Windows PowerShell
```

```bash
cp .env.example .env           # Linux
```

编辑 `.env`，填入 `DEEPSEEK_API_KEY=<你的 key>`。CLI 会自动加载**当前工作目录**下的 `.env`，因此先进入刚创建的 `my-agent`。详见[CLI 使用指南](05-cli-usage.md#4-api-key-管理)。

凭据只放在环境变量中。嵌入式宿主也可提供 `SecretRef` resolver；敏感 Header（包括常见 API key 和 token 别名）不得使用明文字面量。

交互终端可以选择 Provider，非交互脚本须显式使用 `--provider`。本例选择的 `deepseek-flash` 已通过 2.2.0 严格认证。投产前按实际 Provider、模型、凭据和部署环境复测。[供应商矩阵](../providers/README.zh-CN.md) · [2.2.0 严格认证](https://github.com/Eclipseic1848/CoreMind/actions/runs/45939479096)

## 4. 运行

```bash
coremind run coremind.yaml --prompt "翻译：你好，世界"
```

你会看到 agent 流式输出，最后一行是**质量摘要**：

```
✓ 运行完成：工具 0 次调用 · 耗时 2.1s · 约 45 tokens · 输出 18 字
```

## 5. 八个命令

命令怎么装、在哪敲、key 怎么管理、常见坑——详见[CLI 使用指南](05-cli-usage.md)。

| 命令 | 用途 |
|---|---|
| `coremind create <name>` | 新建或接入项目（`--template`、`--language`） |
| `coremind run <file>` | 运行一次（`--prompt` 首条输入 / `--json-events` 输出机器可读事件 / 启用 session 后以 `--session <id>` 保存会话） |
| `coremind chat <file>` | 多轮 TUI（审批、预算、Trace、checkpoint/diff/恢复） |
| `coremind check [file]` | 检查配置、安全、项目材料和质量档 |
| `coremind eval [file]` | 重复运行 `evals/scenarios.yaml` |
| `coremind templates` | 查看当前安装版本的模板（兼容 `list-templates`） |
| `coremind providers` | 查看可配置 Provider 和在线认证矩阵入口 |
| `coremind doctor` | 环境自检（Node 版本 / 配置 / API key 是否存在） |

## 下一步

- 命令怎么装、在哪敲、key 怎么管理？→ [CLI 使用指南](05-cli-usage.md)
- 想改人设、换模型、加工具？→ [配置指南](02-configuration.md)
- 想让 agent 更专业（按 SOP 干活）？→ [技能指南](03-skills.md)
- 跑完不知道好不好？→ [质量与调优](04-quality.md)
- 看看经过完整材料与离线评测的实现？→ [5 个黄金示例](../../examples/golden/README.zh-CN.md)
- 按业务任务组合知识、记忆、本体、工具与 Skill？→ [五个能力域的建设与验收](06-capability-construction.md)
- 按模块学习？→ [能力模块目录](../modules/README.zh-CN.md)
