# 持久运行与故障恢复示例

## 目标

验证“暂停后继续”和“已提交副作用不重放”，而不是制造一个新的业务 Loop。

## 步骤

```powershell
coremind run coremind.yaml --prompt "把验收文字写入 result.md" --json-events
```

1. 在写入审批出现时按 `n`，确认 `snapshot.outcome.status=paused` 且 `snapshot.operation.state=paused`。
2. 记录最后一行的 `runId`。
3. 使用下列命令继续：

```powershell
coremind run coremind.yaml --resume <runId> --json-events
```

4. 批准写入后，确认只有一个 Checkpoint、一个 committed Effect Receipt 和一个目标文件变化。
5. 再次用同一 `runId` 恢复，确认终态 operation 被拒绝继续，而不是再次写入。
6. 比对顶层兼容字段与 `snapshot`，确认 `runId`、operation、outcome、指标和证据一致。

## 故障注入

从仓库根目录运行：

```powershell
npx vitest run packages/coremind-runtime/src/invariant-checker.test.ts packages/coremind-runtime/src/operation-state.test.ts packages/coremind-runtime/src/run-state.test.ts packages/coremind-runtime/src/session.test.ts packages/coremind-runtime/src/snapshot.test.ts packages/coremind-worker/src/server.test.ts --maxWorkers=1
```

检查器测试会在 `gate` 档遍历受 Git 跟踪的当前格式与 0.3.0 fixture；不要用本机 `.coremind` 目录替代验收输入。

返回 [中文指南](../../../docs/modules/recover-durable-runs/GUIDE.zh-CN.md)。
