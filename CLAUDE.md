# CoreMind（星枢智核）

面向普通/初级开发者、新手小白的**配置驱动智能体开发框架**：写一份 `coremind.yaml` 即可构建自己的智能体。核心设计文档见 [PLAN.md](PLAN.md)。

## 技术栈

- TypeScript 全 ESM（`"type": "module"`），Node ≥ 22.19，npm workspaces monorepo
- 测试：vitest；Lint/Format：Biome
- 配置驱动：`coremind.yaml`（YAML/JSON 双格式）定义 provider / agents / workflow

## 代码约定

- 所有注释用中文；源文件 UTF-8
- 依赖方向严格单向：`config ← tools ← runtime ← {coremind, cli}`，禁止反向依赖
- 公共 API（`coremind` 包）只做 re-export，不写业务逻辑

## Agent skills

### Issue tracker

Issues 使用 GitHub Issues 追踪（仓库 `Eclipseic1848/CoreMind`，`gh` CLI 操作）。详见 `docs/agents/issue-tracker.md`。

### Domain docs

单上下文（single-context）布局：领域上下文为根目录 `CONTEXT.md`，架构决策记录在 `docs/adr/`。详见 `docs/agents/domain.md`。
