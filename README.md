<div align="center">

# CoreMind 星擎智核

**面向新手开发者的配置驱动智能体开发框架**

写一份 YAML，构建你自己的 AI 智能体。

[快速开始](#快速开始) · [配置参考](#配置参考) · [工作流](#工作流) · [模板](#场景模板) · [CLI](#cli) · [FAQ](#faq)

</div>

## 为什么选择 CoreMind？

| 特性 | 说明 |
|---|---|
| 🚀 **配置驱动** | 不写代码，`coremind.yaml` 定义模型、人设、工具、工作流 |
| 🧩 **多 Agent 协作** | 按名字定义多个智能体，工作流中互相调用、传递结果 |
| ⚡ **实用编排** | 顺序 / 并行 / if / switch 四类步骤，覆盖 90% 业务场景 |
| 🔌 **模型全兼容** | 内置 DeepSeek / Kimi / 智谱 / MiniMax / OpenAI / Anthropic / Google 等 30+ 提供商，支持任意 OpenAI 兼容端点（Ollama、私有网关） |
| 🛠 **工具即插即用** | 内置文件读写、命令执行、代码搜索、网页抓取，也支持自定义脚本工具 |
| 📦 **库 + CLI 双形态** | `coremind` 库嵌入你的应用；`coremind` CLI 开箱即用 |

## 快速开始

需要 Node.js ≥ 22.19。

```bash
# 1. 从模板创建项目
npx coremind create my-agent --template translator

# 2. 配置 API key（默认使用 DeepSeek，也可用其他提供商）
cd my-agent
copy .env.example .env    # Windows 用 copy，macOS/Linux 用 cp

# 3. 运行
coremind run coremind.yaml --prompt "翻译：你好，世界"
```

一条命令直达你的第一个智能体。查看全部模板：

```bash
coremind list-templates
```

## 配置参考

```yaml
# coremind.yaml —— 完整示例
version: 1
name: weekly-report          # 必填
description: 周报生成器

provider:                    # 缺省 = deepseek
  id: deepseek               # 内置：deepseek / moonshotai-cn / zai / minimax-cn / openai / anthropic / google
  model: deepseek-v4-flash   # 缺省取该提供商默认模型
  # 自定义 OpenAI 兼容端点（Ollama / 本地模型 / 网关）：
  # baseUrl: http://localhost:11434/v1
  # model: qwen2.5:7b
  # apiKeyEnv: OLLAMA_API_KEY

agents:
  collector:                 # 按名字定义智能体
    description: 收集信息
    systemPrompt: 你是信息收集员，只输出事实。
    tools:                   # 缺省继承顶层 tools
      - id: bash
      - id: read
  writer:
    systemPrompt: 你是周报撰写专家。
    tools: []

workflow:                    # 可选：缺省时单 agent 直答
  - id: collect
    type: prompt             # prompt：派发任务；call：委托调用
    agent: collector
    input: 请收集本周代码变更
    saveAs: changes          # 输出保存为 {{changes.text}}
  - id: branch
    type: if                 # 条件分支
    condition: "{{changes.text}} contains 无"
    then: [...]
    else: [...]
  - id: parallel-check
    type: parallel           # 并行执行
    steps: [...]
    saveAs: checks
  - id: classify
    type: switch             # 多路选择（按变量值包含匹配）
    on: checks.text
    cases:
      高风险: [...]
    default: [...]
```

### API key 环境变量

| 提供商 | 环境变量 |
|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` |
| Kimi（Moonshot） | `MOONSHOT_API_KEY` |
| 智谱 Z.ai | `ZAI_API_KEY` |
| MiniMax | `MINIMAX_CN_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |

## 工作流

CoreMind 的编排刻意保持简单——五种步骤，可嵌套，无 DAG：

- **prompt / call**：派发任务给指定 agent，`{{变量}}` 插值，`saveAs` 保存输出
- **parallel**：并行执行子步骤，结果按声明顺序聚合
- **if**：条件分支（支持 `contains`、`==`、`!=` 与真值判定）
- **switch**：按变量值包含匹配多路选择

变量：`{{prompt}}` 是首条用户输入；`{{<saveAs>.text}}` 是步骤输出。安全护栏：嵌套深度 ≤ 8、总步骤 ≤ 100。

## 场景模板

8 个开箱即用模板覆盖四类场景：

| 分类 | 模板 | 亮点 |
|---|---|---|
| 通用任务 | translator · blog-writer | 翻译、写作落盘 |
| 编程辅助 | code-reviewer · bug-squasher | if 分支 · 双 agent 调试 |
| 垂直行业 | hr-interviewer · contract-reviewer | switch 追问 · 合同审查 |
| 工作流 | weekly-report · customer-triage | parallel+if 全特性 · 工单分诊 |

## CLI

```
coremind create <name>       从模板创建项目（--template <id>）
coremind run <file>          运行配置（--prompt/--print/--json-events/--session）
coremind chat <file>         交互式对话
coremind list-templates      列出模板
coremind doctor [file]       环境自检
```

## 作为库使用

```ts
import { loadConfigFile, parseAndValidate, CoreMindRuntime } from "coremind";

const data = await loadConfigFile("coremind.yaml");
const { config } = parseAndValidate(data);

const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  events: (event) => console.log(event),   // 归一化事件流
});
const result = await runtime.run();
console.log(result.transcript);
```

## FAQ

**需要写代码吗？** 基本不需要。90% 场景只用 YAML 配置；高级用户可以写脚本工具（一个 JS 文件）。

**支持本地模型吗？** 支持。自定义 provider 指向任意 OpenAI 兼容端点（如 Ollama：`http://localhost:11434/v1`）。

**免费吗？** CoreMind 本身 MIT 开源免费；模型费用由各提供商收取。

## 开源协议

[MIT](LICENSE) · 上游组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
