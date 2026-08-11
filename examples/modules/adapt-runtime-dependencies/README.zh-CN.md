# Runtime 依赖 Adapter 示例

应用代码只读取 CoreMind 自有兼容性报告，不导入底层类型：

```ts
import { inspectRuntimeCompatibility } from "coremind-ai";

const report = inspectRuntimeCompatibility();
if (!report.capabilities.streaming || !report.capabilities.abort) {
  throw new Error("当前 Runtime 不满足应用要求");
}
console.log(report.dependencyFamily, report.adapterVersion);
```

## 验证步骤

1. 运行 `npm run dependencies:check`，确认三个核心包只有一个精确版本。
2. 运行模块清单中的 Adapter、Provider、工具和 Session 测试。
3. 运行 `coremind doctor .\coremind.yaml`，确认兼容层可观察。
4. 注入一次 Provider 错误和一次 abort，确认终态没有语义漂移。

自定义业务 Adapter 应接受 CoreMind 自有输入并返回 CoreMind 自有结果；如果必须把底层对象暴露给业务调用方，说明 seam 位置错误。

返回[中文指南](../../../docs/modules/adapt-runtime-dependencies/GUIDE.zh-CN.md)。
