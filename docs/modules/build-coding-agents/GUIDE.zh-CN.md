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
2. 运行缺陷测试，确认它在修复前确实失败。
3. 运行 `coremind check coremind.yaml --profile strict`。
4. 运行 `coremind eval coremind.yaml --suite evals/scenarios.yaml --json`。
5. 检查 grader、工具轨迹、最终测试、`git diff`、Trace、Checkpoint 与终态。
6. 重复运行并记录通过率；真实模型只作为补充证据，不能替代确定性测试。

可直接复制 [真实缺陷评测示例](../../../examples/coding-evals/README.zh-CN.md)。
