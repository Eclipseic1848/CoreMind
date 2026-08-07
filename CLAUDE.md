# CoreMind（星枢智核）

面向普通/初级开发者、新手小白的**配置驱动智能体开发框架**：写一份 `coremind.yaml` 即可构建自己的智能体。核心设计文档见 [PLAN.md](PLAN.md)（本地，不上 GitHub）。

## 项目当前状态（2026-08-07）

- **已发布 `0.1.0-alpha.2`**（latest 已更新）：6 个 npm 包（config/tools/templates/runtime/**coremind-ai**/coremind-cli）；115 测试全绿
- 能力全景：质量报告（步骤/token/耗时）、skills 技能系统（3 内置 + 自定义目录技能）、编排护栏（超时/重试/步骤上限）、会话树（断点续聊/自动压缩）、ChatSession 交互库 API、**chat 全屏 TUI**（ink）、引导文档 `docs/guide/`
- 新会话请**先读 [handoff.md](handoff.md)**（交接文档：状态/下一步/20 条踩坑记录）
- PLAN.md、handoff.md 在 .gitignore，**禁止推送**
- 注意：凭据已轮换（2026-08-07），真实 LLM 测试需用户自行设置新 key 环境变量，**key 不进对话**

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
