# Domain docs

本仓库采用 **single-context**（单上下文）布局：

- 根目录 `CONTEXT.md` — 项目领域上下文（由用户维护，AI 消费前先读）
- `docs/adr/` — 架构决策记录（ADR）

## 消费者规则

- 修改领域相关代码前，先读 `CONTEXT.md` 的相关部分
- 新增架构决策时，写入 `docs/adr/`，命名格式 `NNNN-<short-name>.md`（NNNN 为递增序号）
- 领域术语发生变化时，同步更新 `CONTEXT.md`
