# 权限与安全

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

统一执行 ask、assisted、full 三档审批，并明确区分路径感知文件工具、Linux bash OS 沙箱和 Windows shell 风险边界。

## 公共接口

- `ToolPolicy`
- `ApprovalQueue`
- `ToolApprovalRequest`
- `createLinuxSandboxedBashTool`

## 错误与边界

- 没有审批处理器时安全拒绝
- 显式 deny 与路径感知文件工具的越界路径在 full 下也不会放行
- 任意 shell 副作用不承诺自动回退
- Linux bash 当前默认拒绝网络，沙箱不可用时关闭执行

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/tool-policy.ts](../../../packages/coremind-runtime/src/tool-policy.ts)
- [packages/coremind-cli/src/approval.ts](../../../packages/coremind-cli/src/approval.ts)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-runtime/src/tool-policy.test.ts](../../../packages/coremind-runtime/src/tool-policy.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [模块示例](../../../examples/modules/enforce-agent-permissions/README.zh-CN.md)
- [Module example](../../../examples/modules/enforce-agent-permissions/README.en.md)
- [Agent Skill](../../../skills/enforce-agent-permissions/SKILL.md)
