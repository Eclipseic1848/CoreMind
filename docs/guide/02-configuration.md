# 配置指南

`coremind.yaml`（也支持 JSON）是智能体的唯一定义文件。本指南按字段逐个说明。

## 顶层字段

```yaml
version: 1              # 配置格式版本（当前固定 1）
name: my-agent          # 必填：智能体名称
description: 一句话说明
provider: {...}         # 模型提供商（缺省 deepseek）
options: {...}          # 全局模型选项（temperature 等）
tools: [...]            # 全局默认工具（agent 未单独配置时继承）
agents: {...}           # 必填：至少一个智能体
defaultAgent: 名称       # 缺省取第一个
workflow: [...]         # 可选：编排步骤（缺省时单 agent 直答）
session: {...}          # 可选：会话持久化
```

未知字段会告警但**不会报错**——写错字段也能跑，只是会提示。

## provider：模型提供商

```yaml
provider:
  id: deepseek                  # 内置提供商之一
  model: deepseek-v4-flash      # 可选，缺省取该提供商默认模型
  apiKeyEnv: MY_DS_KEY          # 可选：自定义 API key 环境变量名（缺省按 id 推断）
```

**内置提供商**：`deepseek` / `moonshotai-cn`（Kimi）/ `zai`（智谱）/ `minimax-cn` / `openai` / `anthropic` / `google`。

**自定义 OpenAI 兼容端点**（Ollama / 本地模型 / 私有网关）：

```yaml
provider:
  id: ollama
  baseUrl: http://localhost:11434/v1
  model: qwen2.5:7b
  apiKeyEnv: OLLAMA_API_KEY     # 无鉴权时可不配
  # contextWindow: 131072       # 可选：对齐真实模型能力（缺省 32768）
  # maxTokens: 8192             # 可选：最大输出（缺省 4096）
```

API key 来源：`apiKeyEnv` 指定的环境变量 → 缺省按提供商推断（`DEEPSEEK_API_KEY` 等）。

> ⚠️ **不要用 `apiKey` 直填密钥**——会随配置文件进入版本库/分享链路。使用时会告警并引导改用 `apiKeyEnv`。

## agents：智能体定义

```yaml
agents:
  reviewer:
    description: 给其他 agent 看的名片
    systemPrompt: 你是资深代码审查专家。        # 人设（缺省"乐于助人的助手"）
    model: deepseek-v4-flash                  # 可选：覆盖 provider.model
    tools:                                    # 可选：缺省继承全局 tools
      - id: read
      - id: grep
    options:                                  # 可选：模型选项
      temperature: 0.3                        # 0-2，低温度更稳定
      maxTokens: 2000
      thinkingLevel: low                      # off/low/medium/high/xhigh
    skills:                                   # 可选：注入专业技能（见技能指南）
      - code-review
```

## tools：工具

**内置工具**（白名单）：`read` / `ls` / `find` / `grep` / `bash` / `edit` / `write` / `web-fetch` / `web-search`（web-search 需要 `TAVILY_API_KEY`）。

```yaml
tools:
  - id: read
  - id: bash
  - id: web-search          # 未配 key 时会跳过并告警
  - path: ./my-tool.mjs     # 自定义脚本工具（一个 JS 文件，导出工具对象）
```

注意：单个 agent 工具超过 20 个会告警（工具过多会降低模型选择准确率）。

## workflow：编排步骤

五种步骤，可嵌套（parallel/if/switch 内部可再含步骤）：

```yaml
workflow:
  - id: collect
    type: prompt            # 派发任务（call 语义相同，用于委托）
    agent: collector
    input: 请收集信息：{{prompt}}    # {{变量}} 插值
    saveAs: changes         # 输出保存为 {{changes.text}}
    retry:                  # 可选：质量把关——输出不达标自动重试
      max: 2                # 最大重试次数（默认 1）
      if: "{{text}} contains 错误"   # 为真 = 需要重试；{{text}} 是本步输出
  - id: branch
    type: if
    condition: "{{changes.text}} contains 无"
    then: [...]
    else: [...]
  - id: checks
    type: parallel          # 并行执行，结果按声明顺序聚合
    steps: [...]
    saveAs: checks
  - id: classify
    type: switch            # 多路选择（变量值包含 case 键即命中）
    on: checks.text
    cases:
      高风险: [...]
    default: [...]
```

**变量**：`{{prompt}}` = 首条用户输入；`{{<saveAs>.text}}` = 步骤输出。

**护栏**（保证智能体不失控）：嵌套深度 ≤ 8、总步骤 ≤ 100、单步骤超时 5 分钟（超时自动中止）。可用 `--max-steps <n>` 收紧步骤上限。

## session：会话持久化

```yaml
session:
  enabled: true             # 开启会话落盘
  dir: ./sessions           # 可选：存储目录（缺省 ./sessions）
  compact: true             # 可选：上下文超预算时自动压缩（LLM 摘要，消耗 token）
```

配合 `--session <id>`：保存本轮对话；再次运行同一 id 时**自动恢复历史**（重启后上下文不丢）。

```bash
coremind run coremind.yaml --prompt "第一轮" --session my-session
coremind run coremind.yaml --prompt "第二轮" --session my-session   # 已恢复会话 my-session（2 条历史消息）
```

> 会话 id 只能包含**字母、数字、连字符与下划线**（`[a-zA-Z0-9_-]`）——其他字符会报错（防路径穿越）。

## 完整示例

最简配置（单 agent 直答）：

```yaml
version: 1
name: hello
provider:
  id: deepseek
agents:
  assistant:
    systemPrompt: 你是一位友善的 AI 助手。
```
