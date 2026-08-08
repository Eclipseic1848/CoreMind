<div align="center">

# CoreMind（星枢智核）

**把智能体工程经验变成新手也能执行、团队也能复用的标准。**

[![阶段](https://img.shields.io/badge/status-beta%20candidate-2563eb)](docs/roadmap.zh-CN.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-2563eb)](SECURITY.md)
[![文档](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-7c3aed)](docs/index.md)
[![许可证](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

CLI/TUI · TypeScript SDK · Python SDK · 配置驱动 · Harness/Loop · SOP/Skill

[快速开始](docs/guide/01-quickstart.md) · [完整文档](docs/index.md) · [功能模块](docs/modules/README.zh-CN.md) · [供应商矩阵](docs/providers/README.zh-CN.md) · [参与贡献](CONTRIBUTING.md) · [English](README.en.md)

</div>

CoreMind 面向没有智能体开发经验的新手和普通工程师，通过统一 Runtime 提供受控 Harness/Loop、CLI/TUI、TypeScript SDK、Python SDK，以及随功能同步交付的 SOP、Skill、双语指南和离线示例。

> 当前公开版本是 `0.2.0-beta.1`。GitHub、npm、PyPI、双语文档站、Windows/Linux CI 和一个真实 Provider 认证已经完成，欢迎试用并参与社区共建。

[4 个黄金示例](examples/golden/README.zh-CN.md) · [公开路线图](docs/roadmap.zh-CN.md) · [安全策略](SECURITY.md) · [社区行为准则](CODE_OF_CONDUCT.md)

## 当前版本具备什么能力

`0.2.0-beta.1` 是一期统一发布候选，三种入口共用同一个 Runtime 和结果语义：

| 能力域 | 当前支持 |
|---|---|
| 开发入口 | CLI/TUI、TypeScript SDK、Python SDK、完整源码 |
| 智能体编排 | 单 Agent、多 Agent、顺序/并行/条件 Workflow、受预算约束的 Loop、重试与超时 |
| 配置与模型 | Config v2；38 个可配置 Provider；自定义 OpenAI-compatible 端点；当前 1 个 Provider 有完整真实认证证据 |
| 工具与权限 | 内置文件、搜索、网页和脚本工具；TypeScript/Python 自定义工具；`ask`、`assisted`、`full` 三档权限 |
| 可靠运行 | 明确的成功/失败/暂停/中止语义；turn/step/token/费用/工具预算；Trace、RunState、Session、Context 保护和安全恢复 |
| 变更保护 | 工作区路径策略、审批、写前 checkpoint、diff、显式恢复、审计；Linux 内置 shell 额外使用断网沙箱 |
| 质量工程 | `check`、`eval`、development/standard/strict 三档质量门禁、场景评测、失败注入和发布预检 |
| 新手学习 | 8 个场景模板、4 个离线黄金示例、16 个能力模块；每个模块配套测试、SOP、Skill、中英文指南与示例 |
| 项目脚手架 | 新项目或已有工程接入；TypeScript、JavaScript、Python；生成代码/测试骨架、评测场景和项目级指导材料 |
| 当前平台 | Windows 与 Linux 为一期目标平台；自动化本地候选已在 Windows 验证，Linux 以公开 CI 最终验收 |

当前不包含完整 Web 开发环境、官方托管 API、官方 Docker 镜像、纯 Python Runtime 和 macOS 正式支持。详见[公开路线图](docs/roadmap.zh-CN.md)。

## 后续版本计划

| 阶段 | 计划能力 | 不变原则 |
|---|---|---|
| `0.2.x` 一期稳定线 | 完成 Windows/Linux RC 与公开发布；持续修复可靠性问题、扩充真实 Provider 认证、完善 TUI 与安装体验 | CLI、双 SDK、源码共用同一 Runtime；未认证能力不作承诺 |
| 二期 Web 开发环境 | 可视化配置 Agent/工具/Workflow、在线代码编辑、Trace 调试、测试评测、权限审批、项目文件管理和发布指导 | Web 复用 CoreMind Protocol，不建立另一套运行引擎 |
| 后续平台与生态 | macOS 正式支持；持续扩展社区模板、Skill、Provider 证据和业务模块 | 每项能力必须同步交付实现、测试、SOP、Skill、中英文指南和示例 |

二期及后续版本号和发布日期将在一期真实用户反馈后确定。CoreMind 仍不会替用户决定业务目标、审批责任或智能体架构，也不计划提供官方 Docker 镜像或把框架变成托管 SaaS。

## CoreMind 解决什么问题

CoreMind 让没有 Agent 开发经验的工程师先走一条标准路径：

1. 用 `coremind create` 新建项目或接入已有工程。
2. 用 Config v2 明确 Agent、工具、预算、权限和质量档。
3. 用 `run` 或 `chat` 开发，并查看审批、Trace、预算和 checkpoint。
4. 用 `check` 做静态质量门禁，用 `eval` 做业务场景评测。
5. 按项目生成的需求、架构、SOP、测试指南、验收清单和 Skill 继续迭代。

框架不会替用户决定业务目标、数据字段、审批责任或 Agent 架构。用户负责业务与最终验收；CoreMind 负责机制保护、质量证据和开发指导。

## 三种使用方式

| 入口 | 适合谁 | 说明 |
|---|---|---|
| CLI/TUI | 第一次开发 Agent 的工程师 | `create/run/chat/check/eval/doctor/templates` 完整路径 |
| 嵌入式 SDK | 在现有应用中集成 Agent | TypeScript 直接调用统一 Runtime；Python 通过 stdio JSON-RPC 调用同一 Node Runtime |
| 源码 | 需要扩展框架或参与社区开发 | npm workspaces、TypeScript ESM、Python SDK、协议和模块合同全部开放 |

一期正式目标平台是 Windows 与 Linux；macOS 暂列为后续支持。Web 完整开发环境进入二期，一期不提供官方 Docker 镜像或托管 API 平台。

## 快速开始

需要 Node.js ≥ 22.19。

```bash
npm install -g coremind-cli@beta
coremind create my-agent --template translator --language typescript
cd my-agent
copy .env.example .env
coremind check coremind.yaml
coremind run coremind.yaml --prompt "翻译：你好，世界"
coremind eval coremind.yaml
```

Linux 将 `copy` 换成 `cp`。空目录会要求选择 TypeScript、JavaScript 或 Python；已有工程能唯一识别语言时自动判断，混合工程不会猜测。

生成的项目不仅有 `coremind.yaml`，还包括代码/测试骨架、`evals/scenarios.yaml`、中英文需求与架构、开发 SOP、测试指南、验收清单、项目 Skill、决策记录和 checkpoint 目录。已有文件不会被覆盖。

## Config v2 最小安全配置

```yaml
schemaVersion: 2
name: support-agent

provider:
  id: deepseek
  apiKeyEnv: DEEPSEEK_API_KEY

agents:
  main:
    systemPrompt: |
      只根据已确认的业务规则和工具结果回答；信息不足时明确说明。

runtime:
  maxTurns: 12
  maxSteps: 20
  maxToolCalls: 10
  maxToolFailures: 2
  maxRetries: 2
  runTimeoutMs: 120000

permissions:
  mode: ask
  workspaceOnly: true
  network: ask

quality:
  profile: standard
  minScenarioPassRate: 1
  allowOverride: true
```

权限模式：

- `ask`：需要批准的工具逐项询问。
- `assisted`：工作区内低风险文件操作自动批准，高风险操作询问。
- `full`：不逐项询问，但显式 deny、审计、Trace 和 checkpoint 仍然生效；路径感知文件工具继续执行工作区策略。

Linux 上的内置 `bash` 在 OS 级沙箱中运行，当前固定断网、只允许写工作区，并在沙箱不可用时关闭执行而不回退宿主 shell。Windows 一期没有 OS 级 shell 沙箱；`bash` 与任意自定义工具仍按不可逆高风险操作处理。CoreMind 不会把 checkpoint 描述成任意副作用的完整恢复。

Linux 沙箱依赖仍处于上游研究预览阶段，当前作为纵深防御能力使用；安全结论以完整权限策略、恢复机制和自动化测试证据为准。

## CLI/TUI

```text
coremind create <name>       新建项目或接入已有工程
coremind run <file>          无头运行；支持 --print、--json-events、--session、--resume
coremind chat <file>         多轮 TUI/readline；审批、预算、错误与 checkpoint
coremind check [file]        配置、安全、项目材料和质量档门禁
coremind eval [file]         重复运行 evals/scenarios.yaml
coremind doctor [file]       Node、配置与 Provider 环境自检
coremind templates           查看模板（兼容 list-templates）
```

`run/chat/eval` 可用 `--permission ask|assisted|full` 临时选择批准强度，但不会关闭安全边界和审计。TUI 支持 `/status`、`/checkpoints`、`/diff <id>`、`/restore <id>`、`/abort` 和 `/exit`。

## TypeScript SDK

```ts
import {
  CoreMindRuntime,
  defineTool,
  loadConfigFile,
  parseAndValidate,
} from "coremind-ai";

const config = parseAndValidate(await loadConfigFile("coremind.yaml")).config;
const lookupOrder = defineTool<{ orderId: string }>({
  name: "lookup_order",
  description: "查询订单",
  parameters: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
  },
  execute: async ({ orderId }) => ({ orderId, status: "paid" }),
});

const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: "查询 A-100",
  toolDefinitions: [lookupOrder],
  approveTool: async () => "allow",
});
const result = await runtime.run();
console.log(result.outcome, result.metrics, result.transcript);
```

## Python SDK

Python SDK 启动一个常驻 Node worker，通过 CoreMind Protocol v1 使用相同的 Runtime 和结果语义；它不是第二套 Python Agent Loop。

```python
from coremind import CoreMindClient

client = CoreMindClient("coremind.yaml", approval_handler=lambda request: "allow")

@client.tool(description="查询订单")
def lookup_order(order_id: str) -> dict[str, str]:
    return {"id": order_id, "status": "paid"}

with client:
    result = client.run("查询 A-100")
print(result["outcome"], result["transcript"])
```

完整说明见 [Python SDK 模块](docs/modules/embed-coremind-python/README.zh-CN.md)。

## Harness 与质量证据

- 统一 `RunOutcome / RunMetrics / EvaluationReport / ReleaseReadiness`，失败不能伪装为成功。
- turn、step、工具调用/失败、重试、token、费用、步骤与总运行超时预算。
- ask/assisted/full 三档权限，deny、路径和网络策略优先。
- edit/write 前 checkpoint，运行后 diff 与显式恢复；不可逆工具如实标记。
- 带 runId、eventId、sequence、timestamp 的 Trace 与 append-only RunState。
- 意外中断后可从完整 `step_output` 边界继续；已结束运行、配置/输入不匹配或未完成步骤含非重放安全工具时明确拒绝恢复。
- 每个工具调用写入幂等关联标识；业务工具仍需自行用该标识实现收据或去重，CoreMind 不承诺“恰好一次”。
- Provider 调用前的确定性 Context 保护和多轮 Session 恢复。
- development、standard、strict 三档质量门禁；安全错误不可覆盖，其他覆盖必须记录原因并追加到 `.coremind/quality-overrides.jsonl`。

## Provider 策略

CoreMind 提供锁定的 Provider 清单（当前为 37 个继承入口和 1 个原生认证入口），也支持自定义 OpenAI-compatible 端点。可配置不等于 CoreMind Certified；只有经过真实流式、工具调用、结构化结果、多轮和错误处理测试的 Provider 才能标记认证。没有密钥和真实证据时不会过度承诺。

默认无遥测。任何业务数据外传都必须由用户明确授权，密钥应使用 `apiKeyEnv`，不应写入 YAML。

查看自动生成的[供应商矩阵](docs/providers/README.zh-CN.md)和[认证 SOP](docs/providers/CERTIFICATION.zh-CN.md)。

## 学习与验证材料

- [16 个能力模块](docs/modules/README.zh-CN.md)：每个模块均有实现路径、测试、双语 README/SOP/指南、Skill、示例和 `module.yaml`。
- [4 个黄金示例](examples/golden/README.zh-CN.md)：订单助手、合同审核、Python 数据分析、受控调查，均可用本地 mock Provider 离线运行。
- [配置指南](docs/guide/02-configuration.md)、[Skill 指南](docs/guide/03-skills.md)、[质量指南](docs/guide/04-quality.md)、[CLI 指南](docs/guide/05-cli-usage.md)。

## 源码开发

```bash
npm ci
npm run build
npm run check
npm test
npm run build:python-worker
```

`npm run check:modules` 会检查 16 个模块与 4 个黄金示例的双语配对、Skill frontmatter、源码/测试路径、Markdown 链接、Config v2 和版本记录。CI 在 Windows 与 Linux 运行 Node、Python SDK、真实 worker parity 和 wheel 构建。

## 开源协议

[MIT](LICENSE) · [参与贡献](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [社区行为准则](CODE_OF_CONDUCT.md) · 上游组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
