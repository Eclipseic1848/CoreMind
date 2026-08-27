<div align="center">

# CoreMind（星枢智核）

**把智能体工程经验变成新手也能执行、团队也能复用的标准。**

[![阶段](https://img.shields.io/badge/status-stable%200.3.1-22c55e)](docs/roadmap.zh-CN.md)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.19-339933?logo=nodedotjs&logoColor=white)](package.json)
[![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-2563eb)](SECURITY.md)
[![文档](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87%20%7C%20English-7c3aed)](docs/index.md)
[![许可证](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

CLI/TUI · TypeScript SDK · Python SDK · 配置驱动 · Harness/Loop · SOP/Skill

[快速开始](docs/guide/01-quickstart.md) · [在线文档](https://eclipseic1848.github.io/CoreMind/) · [仓库文档](docs/index.md) · [功能模块](docs/modules/README.zh-CN.md) · [供应商矩阵](docs/providers/README.zh-CN.md) · [参与贡献](CONTRIBUTING.md) · [English](README.en.md)

</div>

CoreMind 面向没有智能体开发经验的新手和普通工程师，通过统一 Runtime 提供受控 Harness/Loop、CLI/TUI、TypeScript SDK、Python SDK，以及随功能同步交付的 SOP、Skill、双语指南和离线示例。

> 当前稳定版为已发布的 `0.3.1`，在 `0.3.0` 基础上完成事实域关联、类型化身份、不变量检查、输入收据与取消收敛。可从 [GitHub Release](https://github.com/Eclipseic1848/CoreMind/releases/tag/v0.3.1)、[npm](https://www.npmjs.com/package/coremind-cli/v/0.3.1) 与 [PyPI](https://pypi.org/project/coremind-ai/0.3.1/) 获取。

> `0.3.1` 已从同一提交完成 Windows/Linux 自动矩阵、双平台真实伪终端（Windows ConPTY / Linux PTY）、真实 Provider 复验、最终文档审计和维护者发布授权。Tag、8 个 npm 包、PyPI wheel、独立源码 ZIP、Manifest 和哈希清单均绑定该发布；[双语文档站](https://eclipseic1848.github.io/CoreMind/)同步反映 `0.3.1` 发布状态。

> `0.3.2` 候选已合入 `main`，完成 Node 22 双平台 CI、真实 Provider 七项认证与 RC 验收，汇总统一 Tool Capability、恢复与持久化边界、跨模型 Context 生命周期、ReplayKit、默认显性的本地 Observability 和默认关闭的 Telemetry 外传边界。它尚未创建 Tag、GitHub Release 或 Registry 产物，因此可安装稳定版仍是 `0.3.1`。

> 当前 `main` 还包含面向 `0.4.x` 的 Protocol v2、持久 ControlInbox、RunHandle/cursor/query、AgentDriver 与 ExecutionEnvironment capability seam；v1 在整个 `0.4.x` 保留迁移入口。这些源码已通过 #71/#72 双平台 CI 并合入，但不等于 `0.4.0` 已发布。

> `0.7.x` 未发布源码候选新增完整 Child Run：稳定父子身份、幂等委派、实际 Runtime authority 校验、父预算划拨、结构化取消/join、orphan audit、递归 Projection 与显性的 TUI `/children`。它尚未合入或发布，不支持 durable detach，也没有完成真实多 Agent 产品验收。

[5 个黄金示例](examples/golden/README.zh-CN.md) · [SOP/Skill 索引](docs/modules/SOP-SKILL-INDEX.zh-CN.md) · [版本迁移指南](docs/migrations/0.2-to-0.3.zh-CN.md) · [已知限制](docs/release/KNOWN-LIMITATIONS.zh-CN.md) · [公开路线图](docs/roadmap.zh-CN.md) · [安全策略](SECURITY.md) · [社区行为准则](CODE_OF_CONDUCT.md)

## 当前仓库具备什么能力

当前稳定版 `0.3.1` 与后续源码坚持 CLI/TUI、TypeScript SDK、Python SDK 共用同一个 Runtime 与结果语义；下表同时标明公开稳定能力和当前 `main` 的未发布能力。

| 能力域 | 当前支持 |
|---|---|
| 开发入口 | CLI/TUI、TypeScript SDK、Python SDK、完整源码 |
| 智能体编排 | 单 Agent、多 Agent、顺序/并行/条件 Workflow、公开 verify/repair Loop、无进展检测、暂停恢复与耗尽策略 |
| 配置与模型 | Config v2；40 个可配置 Provider；自定义 OpenAI-compatible 端点；`0.3.2` 候选的七项真实复验覆盖 1 个 Provider，另外 39 个待认证，且不代表候选已发布；真实状态以[供应商矩阵](docs/providers/README.zh-CN.md)为准 |
| 工具与权限 | 内置文件、搜索、网页和脚本工具；TypeScript/Python 自定义工具；受控进程、只读 Git 与有上限的统一 Diff；`ask`、`assisted`、`full` 三档权限 |
| 可靠运行 | 明确的成功/失败/暂停/中止语义；turn/step/token/费用/工具预算；Trace、RunState、Session、Context 保护和安全恢复 |
| 协议与控制 | 稳定版使用 Protocol v1；当前源码可显式启用 Protocol v2 的 RunHandle、cursor 续订、Projection query 与持久控制回执，v1 在整个 `0.4.x` 保留 |
| 执行环境 | 当前源码以 AgentDriver 隔离 reactive loop，并以 ExecutionEnvironment probe 验证进程树、网络、凭据与隔离能力；Windows Trusted Host 不伪装成 sandbox，Linux sandbox 能力不足时失败关闭 |
| 变更保护 | 工作区路径策略、审批、写前 checkpoint、diff、显式恢复、审计；Linux 内置 shell 额外使用断网沙箱 |
| 质量工程 | `check`、`eval`、三档质量门禁、场景评测、七类 grader、脏工作区保护、失败注入、三连跑、覆盖率基线、npm/wheel 干净安装和发布预检 |
| 编码智能体 | 先复现、再定位、最小修改、目标测试、回归测试和差异审查；当前离线 Coding Eval 6/6，二期真实外部同题模型对照尚未执行 |
| 新手学习 | 8 个场景模板、5 个离线黄金示例、2 个真实缺陷仓库、21 个能力模块；每个模块配套测试、SOP、Skill、中英文指南与示例 |
| 项目脚手架 | 新项目或已有工程接入；TypeScript、JavaScript、Python；生成代码/测试骨架、评测场景和项目级指导材料 |
| 当前平台 | Windows 与 Linux；每个可发布候选都必须在同一源码提交完成自动矩阵、双平台 CI、双平台真实伪终端和真实 Provider 复验，安装状态以 Release 与 Registry 为准 |

当前不包含完整 Web 开发环境、官方托管 API、官方 Docker 镜像、纯 Python Runtime 和 macOS 正式支持。详见[公开路线图](docs/roadmap.zh-CN.md)。

## 后续版本计划

| 阶段 | 计划能力 | 不变原则 |
|---|---|---|
| `0.3.1` 稳定版（已发布） | 在 `0.3.0` 基础上完成事实域关联、类型化身份、不变量检查、请求重建、输入收据与取消收敛 | 保持 Config、Protocol、终态、权限、副作用和恢复合同由 CoreMind 持有 |
| `0.3.2` 合并候选（未发布） | 完成 0.3.x-B/C 的工具、恢复、Context、Replay、Observability 与 Telemetry 边界，并通过双平台 CI、真实 Provider 复验和 RC 验收 | 未创建 Tag/Release/Registry；安装命令仍固定 `0.3.1` |
| `0.4.x` 当前源码 | Protocol v2 与 v1 迁移、持久控制、AgentDriver 和 ExecutionEnvironment seam | 不建立第二 Runtime；源码合并不等于 `0.4.0` 发布 |
| `0.7.x` 源码候选 | Subagent 统一为 Child Run，具备独立 Fact、收紧 authority、父预算、取消、orphan audit、Lease 与显性树投影 | 尚未发布；本地跨进程验收已通过，durable detach 与真实多 Agent 产品验收仍未完成 |
| 三期 Web 开发环境 | 可视化配置 Agent/工具/Workflow、在线代码编辑、Trace 调试、测试评测、权限审批、项目文件管理和发布指导 | Web 复用 CoreMind Protocol，不建立另一套运行引擎 |
| 后续平台与生态 | macOS 正式支持；持续扩展社区模板、Skill、Provider 证据和业务模块 | 每项能力必须同步交付实现、测试、SOP、Skill、中英文指南和示例 |

`0.3.x` 将以真实缺陷、社区反馈和发布证据为依据持续迭代。CoreMind 仍不会替用户决定业务目标、审批责任或智能体架构，也不计划提供官方 Docker 镜像或把框架变成托管 SaaS。

`0.3.0-rc.2` 完成 Batch 0～6 并通过公开发布物 Dogfooding；`0.3.0` 稳定版完成二期发布收口。`0.3.1` 完成 0.3.x-A 的事实、身份、不变量与取消收敛。未发布的 `0.3.2` 候选完成 0.3.x-B/C，并在候选 Runtime 上重新完成 `alibaba-model-studio/qwen-plus` 七项真实复验、双平台 CI 和 RC 验收；Registry 与 Release 仍以 `0.3.1` 为准。

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
| CLI/TUI | 第一次开发 Agent 的工程师 | `create/run/chat/check/eval/doctor/templates/providers` 完整路径 |
| 嵌入式 SDK | 在现有应用中集成 Agent | TypeScript 直接调用统一 Runtime；Python 通过 stdio JSON-RPC 调用同一 Node Runtime |
| 源码 | 需要扩展框架或参与社区开发 | npm workspaces、TypeScript ESM、Python SDK、协议和模块合同全部开放 |

正式目标平台仍是 Windows 与 Linux；macOS 暂列为后续支持。Web 完整开发环境进入三期，当前不提供官方 Docker 镜像或托管 API 平台。

## 快速开始

需要 Node.js ≥ 22.19。`0.3.1` 已在 npm Registry 公开，可执行下面的稳定版安装命令。

```bash
npm install -g coremind-cli@0.3.1
coremind providers
coremind create my-agent --template translator --language typescript --provider alibaba-model-studio
cd my-agent
copy .env.example .env
coremind check coremind.yaml
coremind run coremind.yaml --prompt "翻译：你好，世界"
coremind eval coremind.yaml
```

Linux 将 `copy` 换成 `cp`。交互终端会询问 Provider；脚本或 CI 必须显式传入 `--provider`，可用 `coremind providers` 查看清单。空目录会要求选择 TypeScript、JavaScript 或 Python；已有工程能唯一识别语言时自动判断，混合工程不会猜测。

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

Linux 上的内置 `bash` 在 OS 级沙箱中运行，当前固定断网、只允许写工作区，并在沙箱不可用时关闭执行而不回退宿主 shell。Windows 一期没有 OS 级 shell 沙箱；宿主 Shell 只有在 full、`workspaceOnly: false`、`network: allow` 同时选择时开放，其他组合安全拒绝。Git Bash 发现只提供命令兼容性，不提供隔离。CoreMind 不会把 checkpoint 描述成任意副作用的完整恢复。

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

`coremind run` 的退出码可直接用于 PowerShell、CI 和其他自动化：`0` 成功、`1` 失败、`2` 等待人工处理、`3` 预算耗尽、`124` 超时、`130` 中止。使用 `--json-events` 时，stdout 只输出 JSONL，最后一行固定为 `type: "run_result"` 的完整终态；诊断信息写入 stderr。`--print` 与 `--json-events` 不能同时使用，避免机器输出混入普通文本。

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
  effect: { operations: ["read"], reversible: true },
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

Python SDK 启动一个常驻 Node worker，并使用相同的 Runtime 和结果语义；已发布稳定版默认使用 Protocol v1，当前源码可显式启用 Protocol v2，且 v1 在整个 `0.4.x` 保留。它不是第二套 Python Agent Loop。

```python
from coremind import CoreMindClient

client = CoreMindClient("coremind.yaml", approval_handler=lambda request: "allow")

@client.tool(
    description="查询订单",
    effect={"operations": ["read"], "reversible": True},
)
def lookup_order(order_id: str) -> dict[str, str]:
    return {"id": order_id, "status": "paid"}

with client:
    result = client.run("查询 A-100")
print(result["outcome"], result["transcript"])
```

完整说明见 [Python SDK 模块](docs/modules/embed-coremind-python/README.zh-CN.md)。

## Harness 与质量证据

- 统一 `RunOutcome / RunMetrics / EvaluationReport / ReleaseReadiness`；成功、失败、暂停、中止、超时和预算耗尽都通过返回值表达，失败不能伪装为成功。
- turn、step、工具调用/失败、重试、token、费用、步骤与总运行超时预算。
- ask/assisted/full 三档权限，deny、路径和网络策略优先。
- ask 模式下人工拒绝任一工具审批后，被拒绝项和本批次尚未审批的后续工具都会被阻断；本批结果归并后返回 `paused`，不会继续请求模型或重复弹出审批。顺序工作流中的拒绝步骤不会保存输出，后续步骤不会启动。
- edit/write 前 checkpoint，运行后 diff 与显式恢复；恢复前检查工具完成后的文件指纹，检测到人工或并发修改时拒绝覆盖。
- 自定义工具必须声明 `effect.operations` 与 `effect.reversible`；权限层递归检查嵌套路径和 URL，未知副作用在受约束模式下安全拒绝。
- Windows 宿主 Shell 只有在 full、关闭工作区限制、允许网络同时选择时开放，其他组合安全拒绝；Git Bash 不等于隔离；Linux Shell 继续使用操作系统级隔离。
- 带 runId、eventId、sequence、timestamp 的 Trace 与 append-only RunState。
- 意外中断后可从完整 `step_output` 边界继续；已结束运行、配置/输入不匹配或未完成步骤含非重放安全工具时明确拒绝恢复。
- 每个工具调用写入幂等关联标识；业务工具仍需自行用该标识实现收据或去重，CoreMind 不承诺“恰好一次”。
- Provider 调用前按实际模型与请求重新预算 Context；压缩使用事实投影的 TaskState，保留上一完整 Turn 与当前 user 消息，并把摘要和 lineage 持久化到 Session。无可持久化 Session、能力冲突或不可删除集合超限时在网络调用前暂停。
- `RunResult.snapshot` 统一四个入口的 operation、outcome、指标、评测、Trace、Checkpoint、Artifact、扩展收据和恢复判断。
- 生命周期扩展仅开放 before-model、before-tool、after-tool、run-finished 四个事件；能力与信任显式声明，默认不加载未知本地扩展。
- 轻量 experiment → arm → run → trace 记录版本、输入指纹、环境、随机种子、运行结果和 grader，不建立第二套评测终态。
- development、standard、strict 三档质量门禁；安全错误不可覆盖，其他覆盖必须记录原因并追加到 `.coremind/quality-overrides.jsonl`。

## Provider 策略

CoreMind 提供锁定的 40 个可配置 Provider 入口，也支持自定义 OpenAI-compatible 端点。可配置不等于 CoreMind Certified；当前认证必须在同一版本完成流式、工具调用、结构化结果、多轮、abort、错误映射和长上下文七项真实测试。旧证据继续保留用于追溯，但不能替代当前候选复验。`alibaba-model-studio/qwen-plus` 已基于 `0.3.2` 候选完成七项真实复验，因此当前矩阵为 1 个已认证、39 个待认证；这不代表 `0.3.2` 已发布。

默认无遥测。任何业务数据外传都必须由用户明确授权，密钥应使用 `apiKeyEnv`，不应写入 YAML。

查看自动生成的[供应商矩阵](docs/providers/README.zh-CN.md)和[认证 SOP](docs/providers/CERTIFICATION.zh-CN.md)。

## 学习与验证材料

- [22 个能力模块](docs/modules/README.zh-CN.md)：每个模块均有实现路径、测试、双语 README/SOP/指南、Skill、示例和 `module.yaml`；Child Run 模块明确标记为未发布 alpha。
- [5 个黄金示例](examples/golden/README.zh-CN.md)：订单助手、合同审核、Python 数据分析、受控调查与验证修复 Loop，均可用本地 mock Provider 离线运行。
- [2 个编码智能体真实缺陷仓库](examples/coding-evals/README.zh-CN.md)：TypeScript 与 Python 均验证复现、最小修复、目标/回归测试、只读 Git 证据和脏工作区保护。
- [配置指南](docs/guide/02-configuration.md)、[Skill 指南](docs/guide/03-skills.md)、[质量指南](docs/guide/04-quality.md)、[CLI 指南](docs/guide/05-cli-usage.md)。

## 源码开发

```bash
npm ci
npm run build
npm run check
npm run test:stability
npm run test:coverage
npm run test:coding-evals
npm run build:python-worker
npm run release:check-npm
npm run release:test-npm
npm run release:test-source
python -X utf8 -m build --wheel python
npm run release:check-wheel
```

`npm run check:modules` 会检查 22 个模块与 5 个黄金示例的双语配对、Skill frontmatter、源码/测试路径、Markdown 链接、Config v2 和版本记录。CI 同时面向 Windows 与 Linux，连续三次执行 Node 测试，并验证覆盖率不下降、Python SDK、真实 Worker 一致性、黄金示例、编码缺陷评测、npm tarball 和 wheel 干净安装。P20 由目标平台真实伪终端自动验收；若自动脚本与人工可见界面出现差异，再补充人工复核记录。

## 开源协议

[MIT](LICENSE) · [参与贡献](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [社区行为准则](CODE_OF_CONDUCT.md) · 上游组件声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
