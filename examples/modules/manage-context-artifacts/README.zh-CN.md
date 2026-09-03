# 上下文与 Artifact 治理示例

## 运行自动化验证

```powershell
npx vitest run packages/coremind-runtime/src/context.test.ts packages/coremind-runtime/src/result.test.ts packages/coremind-tools/src/artifact-store.test.ts --maxWorkers=1
```

该测试会验证：相同静态输入生成相同前缀；压缩摘要保留关键状态；50MB 输出只产生有界模型预览；完整文件大小和哈希可核验；疑似凭据不会被保存；伪造路径、符号链接、链接目录和检查后替换的文件不会被导入或删除。

## 在嵌入式 SDK 中比较策略

```typescript
import { compareContextStrategies } from "coremind-runtime";

const report = compareContextStrategies(messages, {
  contextWindow: 32_768,
  reserveTokens: 4_096,
  keepRecentTokens: 8_192,
});
console.log(report);
```

这个函数只输出离线指标，不会改动 Runtime 默认值，也不会发起模型请求。

返回 [中文指南](../../../docs/modules/manage-context-artifacts/GUIDE.zh-CN.md)。
