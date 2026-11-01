# Session 与 Context示例

该示例展示模块的最小用法；复制前先由业务负责人确认字段与规则。

```text
session:
  enabled: true
  dir: ./.coremind/sessions
  compact: false
```

## 会话树示例（1.4 开发线）

`npm run build`

`node examples/modules/manage-sessions/branches.mjs`

示例只从 coremind-ai 公共入口导入，使用本地 HTTP 假 Provider，不需要真实密钥。验证分支历史隔离、持久选择、fork 来源和继续对话；临时目录安全清理。它不代替真实 Provider、Linux/Windows CI 或正式发布资格。

## 验证步骤

1. 从仓库根目录运行模块清单中的测试。
2. 配置类示例运行 `coremind check`。
3. 业务输出类示例补充场景后运行 `coremind eval`。
4. 主动注入一次失败，确认 RunOutcome 或退出码明确失败。

返回 [中文指南](../../../docs/modules/manage-sessions/GUIDE.zh-CN.md)。
