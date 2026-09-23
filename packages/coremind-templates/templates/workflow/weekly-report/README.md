# 周报生成器（weekly-report）

扫描本周代码变更并生成周报，保存为 `docs/weekly-report.md`。

## 适用场景

- 每周生成周报：自动收集 git 提交与构建/测试结果，产出结构化周报
- 框架全特性示范：多 agent + `parallel` 并行 + `if` 分支 + 变量传递

## 快速开始

请在待汇总的 Node 代码仓库根目录使用 Linux 终端运行；仓库需提供 `npm run build` 和 `npm test`。`create .` 会向当前仓库添加 CoreMind 文件。复制后先在 `.env` 中填入 `DASHSCOPE_API_KEY`。模板依赖 `bash`；Windows 默认权限组合不允许执行该步骤。

```bash
coremind create . --template weekly-report --provider alibaba-model-studio
cp .env.example .env
coremind run coremind.yaml
```

## 配置要点

- 两个角色：collector（收集事实）、writer（撰写，已配置 `skills: [weekly-report]` 技能）
- 工作流：收集 git 历史 → `if` 判断有无变更 → `parallel` 并行跑构建/测试 → 一次生成并写入周报
- 周报结构（技能约束）：本周工作 / 风险与阻塞 / 下周计划

## 调优提示

- 非 git 仓库环境：collector 的 `git log` 会失败，可在 prompt 中改为指定目录扫描
- 周报粒度：修改 `agents.writer.systemPrompt` 或周报技能内容即可调整风格
