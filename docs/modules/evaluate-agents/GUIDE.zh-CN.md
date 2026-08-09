# 测试、评测与质量门禁上手指南

## 什么时候使用

分离运行成功、指标、业务评测和发布判断，并用可重复场景阻止失败伪装成通过。

## 最小业务文本示例（兼容 schemaVersion 1）

```text
schemaVersion: 1
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    expected:
      contains:
        - 已支付
      notContains:
        - TODO
```

## 多证据示例（推荐 schemaVersion 2）

```yaml
schemaVersion: 2
scenarios:
  - id: repair-discount
    input: 复现并修复折扣计算错误
    repetitions: 3
    graders:
      - { id: outcome, type: outcome, status: succeeded }
      - type: trajectory
        sequence:
          - { tool: bash, result: failed }
          - { tool: read, result: succeeded }
          - { tool: edit, result: succeeded }
          - { tool: bash, result: succeeded }
        maxToolFailures: 1
      - type: command
        command: node
        args: ["--test"]
      - type: file
        path: src/discount.ts
        contains: ["Math.min"]
      - type: diff
        requiredPaths: ["src/discount.ts"]
        allowedPaths: ["src/discount.ts"]
        preserveExisting: true
      - type: state
        maxTurns: 12
        maxApprovals: 0
        maxSecurityFindings: 0
      - type: response
        contains: ["src/discount.ts", "测试"]
```

七类 grader 分别验证终态、工具轨迹、命令、文件、Git 差异、运行状态和最终回答。评测前会记录文件与脏工作区基线；评测命令不通过 Shell 拼接，路径不得逃逸工作区。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/evaluate-agents/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 对代码修改同时检查目标测试、完整回归、允许文件列表和既有脏文件指纹。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
- 不要把首次复现测试的预期失败误判为安全漏洞；安全发现与不可自动回退警告必须分开。
- 不要让自动复核冒充业务负责人或发布负责人签字。
