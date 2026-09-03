# 快速上手

5 分钟跑通第一个智能体。目标读者：会写代码、但第一次接触智能体开发的工程师。

## 1. 安装

需要 Node.js ≥ 22.19。

`coremind-cli@0.7.1` 是本发布线的稳定包；安装前以 npm 实时页面确认公开可用性。

```bash
npm install -g coremind-cli@0.7.1
coremind --version              # 验证安装成功
coremind --help                 # 查看帮助
```

## 2. 从模板创建

```bash
coremind providers
coremind create my-agent --template translator --language typescript --provider alibaba-model-studio
cd my-agent
```

看一下生成的 `coremind.yaml`——这是智能体定义。项目还会生成测试/评测骨架、双语需求与架构、开发 SOP、验收清单、项目 Skill 和 checkpoint 目录；已有文件不会覆盖。

## 3. 配置 API key

```bash
copy .env.example .env          # Windows；Linux 用 cp
# 编辑 .env，填入 DASHSCOPE_API_KEY=<你的 key>
```

`.env` 会被**自动加载**（前提：在你运行命令的目录下，见[CLI 使用指南](05-cli-usage.md#4-api-key-管理)）。

凭据只放在环境变量中。嵌入式宿主也可提供 `SecretRef` resolver；敏感 Header（包括常见 API key 和 token 别名）不得使用明文字面量。

交互终端会询问 Provider；非交互脚本必须显式使用 `--provider`。本例选择阿里云百炼入口；可配置不等于当前版本已认证，实际证据见[供应商矩阵](../providers/README.zh-CN.md)。

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
| `coremind run <file>` | 运行一次（`--prompt` 首条输入 / `--print` 只输出结果 / `--session <id>` 保存会话） |
| `coremind chat <file>` | 多轮 TUI（审批、预算、Trace、checkpoint/diff/恢复） |
| `coremind check [file]` | 检查配置、安全、项目材料和质量档 |
| `coremind eval [file]` | 重复运行 `evals/scenarios.yaml` |
| `coremind templates` | 查看全部 8 个模板（兼容 `list-templates`） |
| `coremind providers` | 查看可配置 Provider 与当前认证状态 |
| `coremind doctor` | 环境自检（Node 版本 / 配置 / API key 是否存在） |

## 下一步

- 命令怎么装、在哪敲、key 怎么管理？→ [CLI 使用指南](05-cli-usage.md)
- 想改人设、换模型、加工具？→ [配置指南](02-configuration.md)
- 想让 agent 更专业（按 SOP 干活）？→ [技能指南](03-skills.md)
- 跑完不知道好不好？→ [质量与调优](04-quality.md)
- 看看经过完整材料与离线评测的实现？→ [5 个黄金示例](../../examples/golden/README.zh-CN.md)
- 按模块学习？→ [22 个能力模块](../modules/README.zh-CN.md)
