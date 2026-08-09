# 权限与安全上手指南

## 什么时候使用

统一执行 ask、assisted、full 三档审批，并明确区分路径感知文件工具、Linux bash OS 沙箱和 Windows shell 风险边界。

## 最小示例

```text
permissions:
  mode: assisted
  workspaceOnly: true
  network: deny
  deny:
    - bash
```

三档模式只决定“谁批准”，不改变显式策略：

| 场景 | ask | assisted | full |
|---|---|---|---|
| 工作区内已声明的低风险读写 | 询问 | 自动批准 | 自动批准 |
| 网络为 `ask` | 询问 | 询问 | 询问 |
| `deny` 命中或路径越界 | 拒绝 | 拒绝 | 拒绝 |
| Windows Shell：`workspaceOnly: true` 或网络不是 `allow` | 拒绝 | 拒绝 | 拒绝 |
| Windows Shell：工作区关闭、网络允许 | 拒绝 | 拒绝 | 执行，但无 OS 隔离 |
| 未声明副作用的自定义工具且存在约束 | 拒绝 | 拒绝 | 拒绝 |

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/enforce-agent-permissions/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 在 Windows 上分别验证文件工具可用，ask/assisted 或任一约束未开放时 `bash` 被拒绝；三项开放时确认使用真实 Git Bash 或 PowerShell，且 Trace、Checkpoint 与审计仍生效。
6. 用 `..`、工作区外绝对路径、其他盘符、UNC 和指向工作区外的目录链接验证路径逃逸全部被拒绝。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
