# 上下文与 Artifact 治理上手指南

## 用户通常不需要配置

稳定前缀、阈值检查、确定性摘要和大输出捕获由统一 Runtime 自动执行。它们不会新增项目记忆文件，也不会改变权限模式。

运行后可从 TypeScript SDK 的 `RunResult.metrics` 查看：

```typescript
console.log(result.metrics.context);
console.log(result.metrics.artifacts);
console.log(result.artifacts ?? []);
```

`promptCacheStatus` 表示锁定模型目录是否明确声明缓存计费能力；`cacheReadTokens` 和 `cacheWriteTokens` 只来自 Provider 返回的真实 usage。

## 查看大输出

当 bash 等工具输出超过模型预览上限时，模型会看到开头、结尾和类似下面的引用：

```text
[Artifact: .coremind/artifacts/<id>.log; sha256=<hash>; mediaType=text/plain; retention=run]
```

在 PowerShell 中核验：

```powershell
Get-ChildItem -LiteralPath .\.coremind\artifacts
Get-FileHash -Algorithm SHA256 -LiteralPath .\.coremind\artifacts\<id>.log
```

在 Linux 中核验：

```bash
ls -lah ./.coremind/artifacts
sha256sum ./.coremind/artifacts/<id>.log
```

## 清理

`retention=run` 是保留意图，不代表任务结束时立即删除。嵌入式 SDK 可在审计完成后显式调用 `ArtifactStore.cleanup()`。不要清理仍被 Trace、缺陷报告或验收记录引用的文件。

## 常见问题

- 看不到 Artifact：输出可能未超过上限，或因疑似凭据被阻断。
- 缓存可用但命中为零：这是正常且真实的结果，不代表框架失效。
- 摘要后任务跑偏：先检查摘要指纹对应内容是否保留关键目标与未完成事项，再比较候选策略。
- 需要跨项目知识：由用户显式设计业务知识库；本模块不会自动收集项目记忆。

完整开发步骤见 [SOP](SOP.zh-CN.md)，最小验证见 [示例](../../../examples/modules/manage-context-artifacts/README.zh-CN.md)。
