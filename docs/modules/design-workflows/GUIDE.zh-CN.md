# Workflow 与显式有界 Loop 上手指南

## 第一步：先选对模式

- 输入经过固定的两三步处理：使用 `workflow`。
- 单个 Agent 自主调用工具即可完成：使用基础 Agent Loop，并设置 Runtime 预算。
- 结果必须经过独立验证，失败后允许有限修复：使用 `loop`。

## 第二步：写最小 Loop 配置

```yaml
agents:
  coder:
    systemPrompt: 生成或修复候选结果
  reviewer:
    systemPrompt: 独立验证，只输出 PASS 或 FAIL

loop:
  execute:
    agent: coder
    input: "执行：{{prompt}}"
  verify:
    agent: reviewer
    input: "验证：{{candidate.text}}"
    passIf: "{{text}} == PASS"
  repair:
    agent: coder
    input: "根据 {{verification.text}} 修复 {{candidate.text}}"
  maxIterations: 3
  maxRepairs: 2
  maxRepeatedAction: 2
  onFailure: repair
  onExhausted: fail
```

`passIf` 必须是可验证的确定性条件。`onFailure: pause` 适合必须先由人工确认的业务；`onFailure: fail` 适合禁止自动修复的任务。

## 第三步：运行与观察

```powershell
coremind check coremind.yaml
coremind run coremind.yaml --prompt "修复候选结果" --json-events
```

检查 `loop_state` 的顺序、最终 `run_result`、工具 Trace、Effect Receipt、预算和 checkpoint。暂停运行使用原 runId 恢复：

```powershell
coremind run coremind.yaml --resume <runId>
```

## 第四步：至少验证六个反例

1. 首次 verify 返回 FAIL，确认进入 repair。
2. repair 后仍 FAIL，确认达到上限后返回 `loop_exhausted`。
3. 连续产生相同候选，确认无进展阈值会暂停或失败。
4. 用户拒绝审批，确认暂停且不重放工具。
5. 注入 503 后恢复，确认只做有界瞬态重试。
6. 在稳定边界退出并恢复，确认已完成步骤与 committed 副作用不重复。

可直接运行[验证修复黄金示例](../../../examples/golden/verified-repair-loop/README.zh-CN.md)，它已覆盖修复成功、暂停恢复和耗尽失败。
