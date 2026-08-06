# 周报生成器（weekly-report）

扫描本周代码变更并生成中英文周报，保存为 `docs/weekly-report.md`。

## 使用

```bash
copy .env.example .env
cd 你的代码仓库目录
coremind run 周报配置路径/coremind.yaml
```

## 说明

**这是 CoreMind 工作流的全特性示范**：

- `parallel`：并行检查构建状态与测试状态
- `if`：无变更时走说明性周报分支
- 多 agent 协作：collector（收集事实）→ writer（撰写周报）
- 工具：bash / grep / read / find / write

首次运行需在代码仓库内（依赖 `git log`）。
