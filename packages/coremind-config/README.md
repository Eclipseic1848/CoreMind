# coremind-config

CoreMind 的配置解析与校验包。它负责读取 `coremind.yaml`、应用默认值，并在智能体开始执行前返回可定位的配置错误。

`ConfigParseError.code` 固定为已登记的 `parse_error`，`ConfigValidationError.code` 固定为 `invalid_config`；上层入口从统一 Error Contract 获得终态、重试和人工处置分类，不在 Config 内维护第二份映射。

```ts
import { loadConfig } from "coremind-config";

const config = await loadConfig("coremind.yaml");
```

自定义脚本工具必须声明 `effect.operations` 和 `effect.reversible`；可用 `pathFields`、`urlFields` 指向嵌套目标。缺失或无效声明会在执行前被配置校验拒绝。

内置编码证据工具 `git_status`、`git_diff`、`git_log` 只执行固定只读 Git 操作，不提供任意子命令或仓库写入。

Agent 的 `delegation.targets` 可显式允许同项目命名 Agent，并为每个目标固定 token、工具调用、费用、wall time、步骤和后代数六维预算。该字段默认关闭；未定义目标和委派给自身会在配置校验阶段失败。

显式 `loop` 支持 execute、verify、repair、可选 planning、最大迭代、最大修复、重复动作检测和失败/耗尽策略。它与静态 `workflow` 互斥，引用的每个 Agent 都必须存在；详见[配置指南](https://github.com/Eclipseic1848/CoreMind/blob/main/docs/guide/02-configuration.md)。

适合框架扩展者直接使用；普通应用建议安装统一入口包 `coremind-ai`。完整配置说明见[项目文档](https://github.com/Eclipseic1848/CoreMind/tree/main/docs/guide)。

许可证：[MIT](https://github.com/Eclipseic1848/CoreMind/blob/main/LICENSE)
