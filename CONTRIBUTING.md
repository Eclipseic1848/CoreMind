# 贡献指南

欢迎为 CoreMind 贡献代码、模板与文档！

## 环境

- Node.js ≥ 22.19
- npm（workspaces monorepo）

## 开发

```bash
npm install          # 安装依赖
npm run build        # 构建全部包
npm test             # 运行全部测试
npm run check        # Biome lint + typecheck
```

## 包结构

```
packages/
├── coremind-config     # 配置 schema / 解析 / 校验（仅依赖 typebox + yaml）
├── coremind-tools      # 内置工具注册表、网页工具、脚本工具加载
├── coremind-runtime    # provider 注册、Agent 构建、编排引擎、会话
├── coremind-templates  # 场景模板（YAML）+ 元数据索引
├── coremind-cli        # CLI（create / run / chat / list-templates / doctor）
└── coremind            # 对外统一入口（聚合 re-export）
```

依赖方向严格单向：`config ← tools ← runtime ← {coremind, cli}`，禁止反向依赖。

## 代码约定

- 注释使用中文，源文件 UTF-8
- 测试：vitest（离线测试用上游提供的 faux provider，不依赖真实 LLM）
- 新增模板：`coremind.yaml` 必须通过 schema 校验，并在 `src/index.ts` 注册元数据

## 提交规范

- 中文提交信息，格式：`类型: 摘要`（类型：feat / fix / docs / refactor / test / chore）
- 提交前保证 `npm run check` 与 `npm test` 通过

## 发布

六个包统一版本同步发布（相互依赖使用精确版本锁定），按依赖顺序：

```
coremind-config → coremind-tools → coremind-runtime → coremind-templates → coremind-ai → coremind-cli
```

`coremind-ai` 为库入口，`coremind-cli` 提供 `coremind` 命令（npm 上 `coremind` 包名已被占用，故库包使用 `coremind-ai`）。
