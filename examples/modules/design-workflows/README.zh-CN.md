# Workflow 与显式有界 Loop 示例

固定两步处理请使用 `workflow`；下面仅展示需要独立验证与有限修复的 `loop`：

```yaml
loop:
  execute:
    agent: coder
    input: "{{prompt}}"
  verify:
    agent: reviewer
    input: "{{candidate.text}}"
    passIf: "{{text}} == PASS"
  repair:
    agent: coder
    input: "{{verification.text}}"
  maxIterations: 3
  maxRepairs: 2
  maxRepeatedAction: 2
  onFailure: repair
  onExhausted: fail
```

完整可运行项目见[验证修复黄金示例](../../golden/verified-repair-loop/README.zh-CN.md)。它会故意让第一次验证失败，并断言修复成功、暂停恢复和耗尽失败三条路径。

## 验证步骤

1. 运行 `coremind check coremind.yaml`。
2. 使用 `--json-events` 检查 `loop_state` 顺序和最终 `run_result`。
3. 注入审批拒绝、503、无进展和耗尽；确认都不会伪装成成功。
4. 使用同一 runId 恢复，确认已完成步骤与 committed 副作用没有重复。

返回[中文指南](../../../docs/modules/design-workflows/GUIDE.zh-CN.md)。
