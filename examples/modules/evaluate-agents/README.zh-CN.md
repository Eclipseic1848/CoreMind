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

## 五项可选能力离线回归

在仓库根目录安装项目依赖后执行。Python 使用同时安装了三个示例依赖的环境。如需指定解释器，设置 `COREMIND_ONTOLOGY_PYTHON`。

```sh
npm run build
python -m pip install -r examples/modules/manage-knowledge/requirements.txt -r examples/modules/manage-memory/requirements.txt -r examples/modules/manage-ontology/requirements.txt
node examples/modules/evaluate-agents/capability-regression.mjs --output .scratch/capability-regression.json
```

回执包含每项能力的观察值及通过状态。知识使用固定未见集、FTS5 和回答回放。记忆运行 MCP 服务和 Hindsight 适配器，用固定响应和确定性消费者判分。Skill 通过实际 Runtime 比较启用与禁用，使用回环模型夹具。工具及本体检查实际回环调用、授权和业务动作回执。任一子评测失败时总入口退出非零，并保留其余评测结果。各项评分方法见[评测 SOP](../../../docs/modules/evaluate-agents/SOP.zh-CN.md#五项可选能力效果回归)。

返回 [中文指南](../../../docs/modules/evaluate-agents/GUIDE.zh-CN.md)。
