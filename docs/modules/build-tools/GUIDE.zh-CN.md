# 工具与业务能力上手指南

## 什么时候使用

通过内置工具、脚本工具或稳定 defineTool 契约连接确定性的业务动作。

## 最小示例

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  effect: { operations: ['read'], reversible: true },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

`operations` 描述工具实际会做什么，不是它的业务名称。读取数据库填 `read`；修改文件填 `write`；启动进程填 `process`；访问 HTTP 服务填 `network`；无法归入前述类别填 `external`。只有框架确实能自动还原全部副作用时才可设置 `reversible: true`。非标准路径或 URL 参数可用 `pathFields`、`urlFields` 声明，例如 `pathFields: ['output.path']`。

工具名必须是业务专用名称，不能使用内置 `read`、`write`、`bash` 等保留名。SDK 定义和脚本注册都会在执行前拒绝冲突。

## 编码工具边界

```ts
import { GitAdapter, ProcessRunner, diffFiles } from "coremind-ai";

const tests = await new ProcessRunner().run({
  command: process.execPath,
  args: ["--test"],
  cwd: process.cwd(),
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

const git = new GitAdapter({ cwd: process.cwd() });
const status = await git.status();
const patch = await git.diff();
const preview = await diffFiles("src/before.ts", "src/after.ts");
```

`ProcessRunner` 接受命令与参数数组，不接受一段待 Shell 解释的拼接字符串。需要显式传递环境变量时，只传任务所需键值；默认不应把密钥复制给子进程。`GitAdapter` 是证据读取器，不提供 checkout、add、commit、reset、clean 或 push。统一 Diff 只适合受限大小的文本文件，超限会明确失败。

## 验证

1. 按 [SOP](SOP.zh-CN.md) 执行。
2. 运行 [模块示例](../../../examples/modules/build-tools/README.zh-CN.md)。
3. 运行 `coremind check`；涉及业务输出时再运行 `coremind eval`。
4. 检查失败状态、预算、Trace、审批和 checkpoint，而不只看最终文字是否流畅。
5. 分别测试嵌套路径越界、网络拒绝、重复调用和工具异常；确认策略在执行前阻断。
6. 分别测试进程超时、中止、输出上限、缺失命令、Git 链接逃逸和超大 Diff。

## 常见误区

- 不要让模型替业务负责人发明规则。
- 不要把一次成功运行当成稳定性证明。
- 不要通过 full 模式绕过 deny、工作区保护、审计或恢复。
- 不要把继承 Provider 误称为已通过真实认证。
