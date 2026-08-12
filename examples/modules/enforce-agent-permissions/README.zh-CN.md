# 权限与安全示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
permissions:
  mode: assisted
  workspaceOnly: true
  network: deny
  deny:
    - bash
```

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。
5. 在 Windows 触发 `bash`；ask、assisted、`workspaceOnly: true` 或网络不是 `allow` 的任一情况都应在执行前拒绝。只有 full、关闭工作区限制、允许网络同时满足时才执行，并确认 Git Bash 或 PowerShell 不被描述为隔离层。
6. 触发一次长正文写入，确认审批框仍完整显示目标路径、副作用和原因。
7. 分别尝试 `..`、绝对路径、其他盘符、UNC 和指向工作区外的目录链接，确认全部在执行前拒绝。
8. 在 ask 模式拒绝第一次写入审批，确认不会再次弹出同一运行的工具审批，文件不存在，终态为 `paused`。

返回 [中文指南](../../../docs/modules/enforce-agent-permissions/GUIDE.zh-CN.md)。
