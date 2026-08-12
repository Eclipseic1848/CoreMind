# 编码智能体上手指南

## 什么时候使用

当任务需要读取工程、复现测试失败、修改少量代码并给出可审查证据时使用。单纯问答、固定数据查询或无需文件修改的业务，不需要套用编码流程。

## 最小配置

```yaml
schemaVersion: 2
name: safe-coder
provider:
  id: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
agents:
  main:
    systemPrompt: |
      先复现失败并定位原因，只做完成任务所需的最小修改。
      修改后运行目标测试和完整回归测试，最后报告文件、差异和测试结果。
    tools:
      - id: read
      - id: edit
      - id: write
      - id: git_status
      - id: git_diff
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
runtime:
  maxTurns: 20
  maxToolCalls: 30
  maxToolFailures: 3
quality:
  profile: standard
```

在 Windows 的受约束模式下，测试命令不会通过宿主 Shell 自动执行。开发者可先手工运行测试，或在明确接受宿主进程、工作区与网络边界后选择开放条件。Linux 可在隔离前置条件满足时使用内置 Shell。

## TypeScript SDK：建立工程闭环

```ts
import {
  buildRepositoryMap,
  createEngineeringKernelDefinition,
  createEngineeringTaskPlan,
  inspectCodingRepository,
  selectCodingEnvironment,
} from "coremind-ai";

const inspection = await inspectCodingRepository(process.cwd());
// 有歧义时先把 inspection 展示给用户，再把用户选择传入；不要静默替用户决定。
const selection = await selectCodingEnvironment(inspection, {
  language: "typescript",
  packageManager: "npm",
  testCommand: "npm test",
});
const repoMap = buildRepositoryMap(inspection, selection);
const plan = createEngineeringTaskPlan({
  task: "修复订单折扣计算",
  acceptanceCriteria: ["目标测试通过", "完整回归通过", "Diff 只包含任务文件"],
  selection,
});
const kernel = createEngineeringKernelDefinition({ selection });
```

`kernel.loop` 直接交给通用 Runtime 的 Loop 配置处理；`repoMap` 和 `plan` 属于 Coding 领域输入，不会改变通用终态。文件变更后用 `EngineeringEvidenceLedger` 记录 checkpoint、Diff 和真实退出码。Python SDK 通过 Worker/Protocol 使用同一 Runtime，不创建 Python 专属 Loop。

## schemaVersion 2 评测

```yaml
schemaVersion: 2
scenarios:
  - id: repair-tax
    input: 复现并修复税费计算错误
    graders:
      - { id: outcome, type: outcome, status: succeeded }
      - type: trajectory
        sequence:
          - { tool: bash, result: failed }
          - { tool: read, result: succeeded }
          - { tool: edit, result: succeeded }
          - { tool: bash, result: succeeded }
      - type: command
        command: python
        args: ["-m", "unittest", "discover", "-s", "tests"]
      - type: diff
        requiredPaths: ["src/pricing.py"]
        allowedPaths: ["src/pricing.py"]
        preserveExisting: true
      - type: state
        maxSecurityFindings: 0
      - type: response
        contains: ["测试", "src/pricing.py"]
```

## 验证

1. 先保存 `git status --short` 和受保护文件指纹。
2. 查看探测建议，并在歧义时明确选择语言、包管理器和测试命令。
3. 运行缺陷测试，确认它在修复前确实失败。
4. 运行 `coremind check coremind.yaml --profile strict`。
5. 运行 `coremind eval coremind.yaml --suite evals/scenarios.yaml --json`。
6. 检查计划、实际工具、checkpoint、目标测试、回归测试、`git diff`、Trace 与终态是否一致。
7. 执行 `npm run test:coding-evals`，确认 TypeScript/Python 单文件与跨文件门禁全部通过。
8. 重复运行并记录通过率；真实模型只作为补充证据，不能替代确定性测试。

可直接复制 [真实缺陷评测示例](../../../examples/coding-evals/README.zh-CN.md)。
