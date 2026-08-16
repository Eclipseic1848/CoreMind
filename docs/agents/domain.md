# Domain docs

本仓库采用 **single-context** 布局。工程 Skills 在探索和修改代码前，按本文件规则读取领域文档。

## 读取入口

- 根目录 `CONTEXT.md`：项目领域上下文与统一术语。
- `docs/adr/`：影响整个 CoreMind 的架构决策记录。

如果这些文件或目录尚不存在，静默继续，不将其缺失视为阻断，也不要求预先创建。仅在术语或架构决策真正需要固化时，通过 `domain-modeling` 等流程按需建立。

## 文件布局

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-<short-name>.md
│       └── 0002-<short-name>.md
└── packages/
```

## 消费规则

- 修改领域相关代码前，先读取 `CONTEXT.md` 中与任务相关的部分。
- 阅读 `docs/adr/` 中影响目标模块的决策。
- Issue 标题、重构方案、假设和测试名称使用 `CONTEXT.md` 定义的术语，避免自行替换同义词。
- 如果所需概念尚未出现在领域词汇中，先判断是用词偏离还是确有建模缺口。
- 输出若与已有 ADR 冲突，必须明确指出冲突及理由，不得静默覆盖。
- 新 ADR 使用 `NNNN-<short-name>.md` 命名，其中 `NNNN` 为递增编号。
