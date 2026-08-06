# CoreMind（星擎智核）智能体开发框架 — 实施计划

## Context（背景）

在 `F:\new branch` 下已下载的开源 agent 框架基础上，搭建**面向新手/初级开发者的配置驱动智能体开发框架 CoreMind（星擎智核）**。经对比 7 个候选框架，选定其中架构最模块化的一个为技术底座（其核心包均 MIT 协议、纯 ESM、Node ≥ 22.19，已确认 npm 上有活跃发布版本）。经多轮需求问答确认：配置驱动低代码形态、全场景（通用/编程/垂直/工作流）、正式开源产品定位、CLI+库+Web(二期) 三入口、简化编排（无 DAG）、MVP 核心先行。

**核心技术决策**：不 fork 上游源码，直接 npm 依赖上游两个核心包：
- **模型接入包**（统一多模型 API）：35+ 内置模型提供商（含 DeepSeek/Kimi/智谱/小米等国内模型），支持自定义 OpenAI 兼容端点（覆盖 Ollama/本地模型/网关）、env API key、流式事件协议。
- **运行时核心包**（headless Agent 运行时）：纯库零 UI 依赖，`Agent` 类 + 工具调用 + 事件订阅 + 会话持久化，且自带离线测试机制（`registerFauxProvider()` 预置模型响应跑完整 agent 循环）。

工具工厂（read/bash/edit/write/grep/find/ls）从上游工具包导入复用。探索阶段已核实关键 API（Agent 构造、streamFn 绑定、createModels 等）均可用。

## Monorepo 结构（npm workspaces）

```
F:\new branch\CoreMind\
├── package.json / tsconfig.base.json / biome.json / vitest.workspace.ts / LICENSE / .npmrc
├── THIRD_PARTY_NOTICES.md        # 上游框架 MIT 归属声明（合规必需）
├── .github/workflows/ci.yml
├── packages/
│   ├── coremind-config/          # private：schema(TypeBox)+parse+validate，仅依赖 typebox+yaml
│   ├── coremind-tools/           # private：内置工具注册表 + 自定义脚本工具加载
│   ├── coremind-runtime/         # private：provider 注册、Agent 构建、编排引擎、会话、事件归一化
│   ├── coremind-templates/       # private：8 个模板(YAML) + TEMPLATES 元数据索引
│   ├── coremind-cli/             # 发布：coremind-cli（bin: coremind）
│   └── coremind/                 # 发布：coremind（聚合门面，仅 re-export，不写业务逻辑）
├── apps/coremind-web/            # 二期占位（仅 README+package.json）
├── examples/                     # 3 个示例（单agent/多agent/工作流）
└── scripts/
```

依赖方向严格单向：`config ← tools ← runtime ← {coremind, cli}`。**一期只发布 2 个 npm 包**：`coremind`（库：`buildAgentFromConfig`/`CoreMindRuntime`/`loadConfig`）与 `coremind-cli`（bin: `coremind`），其余 `"private": true`。`engines: node >=22.19.0`，全 ESM。

## 配置格式（coremind.yaml，YAML/JSON 双格式同 schema）

顶层字段：`version / name(必填) / description / provider / tools / options / agents / defaultAgent / workflow / session`。

- **provider**：内置 id（如 `deepseek`，apiKey 自动读 `DEEPSEEK_API_KEY`，可用 `apiKeyEnv` 覆盖）；或自定义 OpenAI 兼容端点 `{ baseUrl, model, api: "openai-completions", apiKey/apiKeyEnv, headers }`（覆盖 Ollama/本地模型/网关）。
- **agents**：`Record<名字, { systemPrompt, model?, tools[], options?, description? }>`，多 agent 按名字定义。
- **tools**：内置白名单 `read/ls/find/grep/bash/edit/write/web-fetch/web-search` + 自定义脚本工具 `{ path }`（导出符合 `AgentTool` 形状的 default 对象，schema 用原生 TypeBox；一期不做 JSON→TypeBox 转换）。
- **workflow**：`prompt`(派发任务，`{{变量}}` 插值，`saveAs` 存 outputs) / `call`(委托另一 agent) / `parallel` / `if`(条件仅 `==`/`!=`/`contains`+truthiness，约 100 行手写求值器) / `switch`。
- 新手友好：未知字段告警不报错；可选字段合理默认（默认 provider=deepseek）；错误信息中文可读。

## 运行时封装要点（coremind-runtime）

| 模块 | 职责与关键接线 |
|---|---|
| `provider.ts` | `buildModels(config)`：内置 id 走上游模型包 provider 工厂注册进 `createModels()`；自定义走 `createProvider({ baseUrl, auth: envApiKeyAuth(...), models: [手工构造 Model], api: openAICompletionsApi() })`。**手工 Model 的 cost 字段必须给全 0**（计费计算缺字段出 NaN） |
| `agent-factory.ts` | `new Agent({ initialState: { systemPrompt, model, tools, messages }, streamFn: (m,c,o) => models.streamSimple(m,c,o) })`——**显式传绑定的 streamFn** 才能用上自定义 baseUrl/headers；subscribe 转发事件 |
| `orchestrator.ts` | 简化编排引擎：switch 分发 5 种步骤；`{{var}}` 正则插值；parallel 用 Promise.all 共享 outputs；**护栏：depth ≤ 8、总步骤 ≤ 100**，超限抛 `CoreMindError("step_limit")`；SIGINT→全 agent abort |
| `events.ts` | `CoreMindEvent` 归一化（`agent_start/text_delta/tool_call/tool_result/step_start/step_end/agent_end/error`）——**二期 Web 面板的契约** |
| `session.ts` | 复用上游 JSONL 会话存储仅落盘消息；二期再启用会话树构建做断点续聊 |
| `runtime.ts` | `CoreMindRuntime` 门面 + `buildAgentFromConfig(config, opts)` 库 API |

**决策**：MVP 用 `Agent` + 可选 Session 落盘，不用上游的 `AgentHarness`（其会话树/压缩与固定 prompt 流程绑定，适配任意 YAML workflow 成本高；压缩相关函数二期直接复用）。

## CLI 设计（一期 5 命令，不用上游 TUI 组件库）

- `coremind create <name>`：readline 选模板或 `--template <id>`；复制模板 + 替换 name/description + 生成 `.env.example`
- `coremind run <file>`：校验→构建→执行。`--prompt` 首条输入 / `--print` 纯文本 / `--session <id>` 恢复 / `--max-steps` / `--json-events`（JSONL 事件，供二期 Web）
- `coremind chat`：readline 循环交互，流式输出
- `coremind list-templates` / `coremind doctor`（Node 版本、配置解析、provider 鉴权检查）

交互层用 `node:readline/promises` + ANSI 渲染（~150 行），**渲染与无头执行层解耦**（`--print`/`--json-events` 复用无头层，二期 Web 面板直接对接）。

## 模板库（8 个，覆盖四类场景）

`general/` translator（中英互译）、blog-writer；`coding/` code-reviewer（if 分支）、bug-squasher（**双 agent**+call）；`industry/` hr-interviewer（switch 追问）、contract-reviewer（合同风险审查）；`workflow/` weekly-report（**parallel+if+多 agent 全特性示范**）、customer-triage（双 agent+switch）。每个模板 = `coremind.yaml + README.md + .env.example`，目录组织借鉴上游角色库的分类 + 元数据索引 `src/index.ts`（name/category/description/requiresEnv）。CI 校验所有模板过 schema。

## MVP 实施步骤（每步可验证）

1. **S1 脚手架**：workspaces 根配置 + 6 包空壳 + LICENSE/README → `npm install`、`npm run build --workspaces`、`biome check` 通过
2. **S2 coremind-config**：schema 五件套 + parse/validate → vitest：YAML/JSON roundtrip、默认值、中文报错
3. **S3 coremind-tools**：7 个上游工具工厂包装 + web-fetch 自建（原生 fetch+HTML 提取）+ script-tool 加载器 → 单测注册表/加载
4. **S4 runtime（provider+agent）**：provider.ts/agent-factory.ts/events.ts/errors.ts → **用 `registerFauxProvider()` 离线测**：配置→Agent 跑通、工具执行回传、事件序列
5. **S5 runtime（编排+会话）**：orchestrator.ts/session.ts/runtime.ts → faux 离线测：顺序/并行(时序)/if/switch/多 agent/插值/护栏
6. **S6 CLI**：5 命令 + render → e2e（vitest spawn 子进程 + **mock OpenAI server**：`node:http` 实现 chat/completions 兼容端点，顺带验证自定义 provider 路径）
7. **S7 模板库**：8 模板 + 索引 → `list-templates` 输出 8 项、全部过 schema 校验
8. **S8 示例与测试**：examples/ 3 例；真实 LLM 集成测试 opt-in（`REAL_LLM_TEST=1` + DEEPSEEK_API_KEY）
9. **S9 发布准备**：README/CONTRIBUTING/SECURITY/THIRD_PARTY_NOTICES/CI（install→biome→build→test→examples smoke→publish dry-run）
10. **S10 发布**：`coremind` + `coremind-cli` 发 npm alpha → `npm i coremind` 后可 `import { buildAgentFromConfig }`；`npx coremind create hello` 可跑

S2/S3 可并行；S4/S5 风险最高（上游 API 接线）优先。

## 风险与对策（要点）

- **上游版本**：实施前先以 npm 最新版为准（探索阶段已确认 0.83.0 在 npm 上活跃发布；本地源码目录仅作 API 参考）；**实施第一步先写最小冒烟脚本**验证 Agent 构建 + streamSimple 调用，再正式开发；三包同步 `~` 浮动版本 + 提交 lockfile
- **上游工具包依赖较重**（含 TUI 库与原生二进制）：一期接受，二期可 vendor 工具工厂（MIT 合规，保留版权头）
- **streamFn 契约**：不得 throw，错误编码进事件流；绑定后禁止自行 catch 后 throw
- **Windows 兼容**：脚本工具动态 import 用 `pathToFileURL`；模板 bash 命令跨平台
- **死循环**：depth/步骤数硬上限；会话文件一期单进程不锁

## 验证方案（端到端）

1. **单测**（vitest）：config 解析/校验、interpolate/evalCondition、工具注册
2. **运行时集成**（离线）：`registerFauxProvider()` 预置响应跑完整 Agent 循环与编排——无需网络
3. **CLI e2e**：vitest spawn + mock OpenAI server（覆盖 list-templates/create/doctor/run --print 与自定义 provider 路径）
4. **真实 LLM**：opt-in（`REAL_LLM_TEST=1`），`coremind run examples/weekly-report.yaml --print` 手工冒烟
5. **发布验证**：`npm publish --dry-run` + CI 全绿

**关键待创建文件**：`packages/coremind-config/src/schema/config.ts`（全部类型源头）、`packages/coremind-runtime/src/provider.ts`、`agent-factory.ts`、`orchestrator.ts`、`packages/coremind-cli/src/commands/run.ts`（无头执行层基座）。
