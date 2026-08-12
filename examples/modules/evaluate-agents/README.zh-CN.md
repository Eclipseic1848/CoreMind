# 测试、评测与质量门禁示例

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

返回 [中文指南](../../../docs/modules/evaluate-agents/GUIDE.zh-CN.md)。
