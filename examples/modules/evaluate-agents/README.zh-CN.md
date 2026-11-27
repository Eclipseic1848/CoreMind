# 测试、评测与质量门禁示例

本轮验证的模型快照、通过率和失败原因见[任务泛化验证报告](./GENERALIZATION.zh-CN.md)。

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
schemaVersion: 2
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    repetitions: 3
    graders:
      - { type: outcome, status: succeeded }
      - { type: response, contains: [已支付], notContains: [TODO] }
      - { type: state, maxToolFailures: 0, maxSecurityFindings: 0 }
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 涉及代码修改时参考 [真实缺陷评测](../../coding-evals/README.zh-CN.md)，同时校验命令、文件、差异和脏工作区保护。
6. 比较两个策略时，用 `defineExperiment` 固定版本、seed、arm 权重和输入指纹，并把完整 Trace 与 grader 写入 `ExperimentRecord`。

## 五项可选能力离线回归

在仓库根目录安装项目依赖后执行。Python 使用同时安装了三个示例依赖的环境。如需指定解释器，设置 `COREMIND_ONTOLOGY_PYTHON`。

```sh
npm run build
python -m pip install -r examples/modules/manage-knowledge/requirements.txt -r examples/modules/manage-memory/requirements.txt -r examples/modules/manage-ontology/requirements.txt
node examples/modules/evaluate-agents/capability-regression.mjs --output .scratch/capability-regression.json
```

回执包含每项能力的观察值及通过状态。知识使用固定未见集、FTS5 和回答回放。记忆运行 MCP 服务和 Hindsight 适配器，用固定响应和确定性消费者判分。Skill 通过实际 Runtime 比较启用与禁用，使用回环模型夹具。工具及本体检查实际回环调用、授权和业务动作回执。任一子评测失败时总入口退出非零，并保留其余评测结果。各项评分方法见[评测 SOP](../../../docs/modules/evaluate-agents/SOP.zh-CN.md#五项可选能力效果回归)。

## 历史回归与任务泛化

从仓库根目录安装工作区依赖。评测命令先构建再运行全部套件，同一 seed 可复算相同的输入和预期值。对比两个版本时分别指定输出目录。

```sh
npm ci
npm run eval:generalization -- --seed 20261126 --output .scratch/generalization-eval
```

追加 `--only workflow` 可单独运行一项。默认 `all` 运行以下六项。

单项重跑的回执写入指定输出目录的 `only-<套件名>/`，可与全量报告同时保留。比较两次实测时使用独立输出目录。

在环境中设置 `DASHSCOPE_API_KEY`，追加 `--public` 可通过阿里云百炼运行固定公网快照 `deepseek-v4.1-flash-1017`。仅跑知识生成可选 `--only public-knowledge`。40 道题使用仓库合成资料，按正确回答含引用、或无依据时主动拒答计分，结果保存在 `public-knowledge.json`。本地 BGE-M3 权重只负责检索。

公网黄金业务与编码分别可用 `--only public-business`、`--only public-coding` 重跑。全部运行可使用 `npm run eval:generalization -- --public --seed 20261126 --output .scratch/generalization-eval`。这些选项会向所选公网服务发送合成测试，并使用该账户的调用额度。

可独立比较修复循环的两种验收方式。使用 `node examples/modules/evaluate-agents/business-public.mjs --only verified-repair-loop --host-loop --output .scratch/host-loop` 让合成变体走 Runtime 的宿主验收，并记录每次候选与决定。省略 `--host-loop` 会运行文本验收。原始黄金题仍用原验收方式及评分规则。公共编码变体在提示里公开一个数值样本，宿主另保留一个隐藏样本。

| `--only` | 验证内容 |
| --- | --- |
| `history` | Golden、编码缺陷、销售分析、持久任务测试及 Node/Python 示例。 |
| `capabilities` | 知识检索、记忆、Skill、工具、本体、材料处理及宿主验收。单独盘点现有 Run 日志。 |
| `durable` | 通过公开 `TaskSession` 对已注册类型生成检查点、重开、取消和重放变体。 |
| `workflow` | 用回显 Agent 运行真实配置校验、五种 Workflow 节点及 Loop，核对分支、重试和验收。 |
| `business` | 运行五个 Golden 业务示例的输入变体。模型响应来自本地夹具，销售分析执行 Python 工具。 |
| `retrieval` | 用新合成的资料和查询运行 `KnowledgeCatalog` 检索，需要本地检索模型。 |

`history`、`business`、`capabilities` 和 `retrieval` 涉及 Python。一般解释器默认从 PATH 使用 `python`。全量运行前准备以下环境，解释器变量填可执行文件路径。

| 环境变量 | 用途 |
| --- | --- |
| `COREMIND_ONTOLOGY_PYTHON` | 一般 Python 及本体、记忆、Skill 等示例依赖，见上方的安装命令。 |
| `COREMIND_RETRIEVAL_PYTHON` | 带 Qdrant、ONNX 和 tokenizer 的检索环境，依赖见 `examples/knowledge-evals/zh-retrieval/requirements-retrieval.txt`。默认用一般解释器。 |
| `COREMIND_DOCLING_PYTHON` | 带 Docling 的解析测试环境。默认用一般解释器。 |
| `COREMIND_RETRIEVAL_MODEL_DIR` | 本地 BGE-M3 目录，须含 `model_quantized.onnx`、`tokenizer.json`。模型准备步骤见[知识示例](../manage-knowledge/README.zh-CN.md)。 |

总结果在 `report.json`，包括每个套件耗时、每种任务通过数、类别分布和失败 ID。各生成套件将逐例的输入、预期、实测值与耗时保存到 `<suite>-cases.json`。历史基线另写测试日志，可选能力的命令回执在 `capability-history/`。全部选定检查和覆盖门槛通过时退出码为 0，失败时为非零。缺少依赖或模型的检查会记录失败。

### 新增持久任务类型

在仓库根目录把以下示例保存为 `trim-title.mjs`，构建后执行 `node trim-title.mjs`。这是一个纯状态任务，从 `start` 的检查点读取标题。每次 `resume` 执行一个已注册阶段，返回的检查点同样接受同步 JSON Schema draft-07 校验。

```js
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSession } from "coremind-ai";

const definition = {
  type: "trim-title",
  version: 1,
  initialPhase: "trim",
  checkpointSchema: { type: "string", pattern: "\\S" },
  phases: {
    trim: ({ task }) => ({ phase: "trim", checkpoint: task.checkpoint.trim(), done: true }),
  },
};
const workspace = await mkdtemp(join(await realpath(tmpdir()), "coremind-trim-"));
let session;
try {
  session = await TaskSession.open({ workspace, sessionId: "demo", definitions: [definition] });
  await session.start({ taskId: "edit", type: "trim-title", checkpoint: "  Release  " });
  const result = await session.resume("edit");
  assert.equal(result.status, "completed");
  assert.equal(result.checkpoint, "Release");
} finally {
  await session?.close();
  await rm(workspace, { recursive: true, force: true });
}
```

业务类型通过 `TaskSession.open({ definitions })` 注册。用稳定的 `type`、正整数 `version`、初始阶段、检查点 schema 和阶段函数描述它。在 `durable-generalization.mjs` 注册该定义，生成每类型至少 30 个不同输入或操作序列，用独立预期核对状态、检查点及拒绝码，再运行 `--only durable`。例如此类型应覆盖保留内部空格、去掉首尾空白、拒绝空白字符串、参数缺失、对象类型和已完成任务重放。涉及已持久化的旧版本时，提供 `migrate` 并验证重开。

YAML 的 `prompt`、`call`、`parallel`、`if`、`switch` 是配置语言内置节点。可先组合现有节点实现业务流程。要扩展节点语法，应同步更新递归配置 schema、步骤遍历、Orchestrator 执行分派和 `workflow-generalization.mjs`。条件运算符 `==`、`!=`、`contains` 写在模板中，插值结果作为操作数。新 Golden 业务样本及其业务断言放在 `business-generalization.mjs`。

返回 [中文指南](../../../docs/modules/evaluate-agents/GUIDE.zh-CN.md)。
