# Runtime 生命周期扩展示例

该示例覆盖两个推荐起点：只读 Trace exporter 和附加 deny-policy。示例不会自动加载项目代码。

```ts
import {
  CoreMindRuntime,
  createDenyPolicyExtension,
  createTraceExporterExtension,
} from "coremind-ai";

const received: string[] = [];
const exporter = createTraceExporterExtension({
  id: "trace-exporter",
  exporter: (event) => received.push(event.type),
});
const deny = createDenyPolicyExtension({ id: "deny-shell", deniedTools: ["bash"] });

const extensions = [exporter, deny];
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  lifecycleExtensions: {
    extensions,
    trustedIds: extensions.map((item) => item.id),
    grants: Object.fromEntries(extensions.map((item) => [item.id, item.capabilities])),
    timeoutMs: 500,
  },
});

const result = await runtime.run();
console.log(result.outcome, result.extensions, received);
```

验证：运行模块测试，确认 `bash` 未执行、拒绝前没有 Checkpoint、四类事件收据可审计，且 exporter 抛错时 `result.outcome` 仍反映真实运行结果。

返回[中文指南](../../../docs/modules/extend-runtime-lifecycle/GUIDE.zh-CN.md)。
