# 快速上手

5 分钟跑通第一个智能体。目标读者：会写代码、但第一次接触智能体开发的工程师。

## 1. 安装

需要 Node.js ≥ 22.19。

```bash
npm install -g coremind-cli@alpha   # 提供 coremind 命令（@alpha：当前以 alpha 版本发布）
coremind --help                 # 查看帮助
```

## 2. 从模板创建

```bash
coremind create my-agent --template translator
cd my-agent
```

看一下生成的 `coremind.yaml`——这就是你的智能体定义：模型、人设、工具都在里面。

## 3. 配置 API key

```bash
copy .env.example .env          # Windows；macOS/Linux 用 cp
# 编辑 .env，填入 DEEPSEEK_API_KEY=<你的 key>
```

缺省使用 DeepSeek 模型；其他提供商见[配置指南](02-configuration.md#provider)。

## 4. 运行

```bash
coremind run coremind.yaml --prompt "翻译：你好，世界"
```

你会看到 agent 流式输出，最后一行是**质量摘要**：

```
✓ 运行完成：工具 0 次调用 · 耗时 2.1s · 约 45 tokens · 输出 18 字
```

## 5. 五个命令

| 命令 | 用途 |
|---|---|
| `coremind create <name>` | 从模板创建项目（`--template <id>` 非交互） |
| `coremind run <file>` | 运行一次（`--prompt` 首条输入 / `--print` 只输出结果 / `--session <id>` 保存会话） |
| `coremind chat <file>` | 交互式多轮对话（`/help` `/exit` `/abort` 命令，工具调用实时展示） |
| `coremind list-templates` | 查看全部 8 个模板 |
| `coremind doctor` | 环境自检（Node 版本 / 配置 / API key 是否存在） |

## 下一步

- 想改人设、换模型、加工具？→ [配置指南](02-configuration.md)
- 想让 agent 更专业（按 SOP 干活）？→ [技能指南](03-skills.md)
- 跑完不知道好不好？→ [质量与调优](04-quality.md)
- 看看别人怎么做？→ 8 个[场景模板](../README.md#场景模板)（每个模板自带 README 说明）
