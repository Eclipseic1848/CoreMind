# Runtime 生命周期扩展上手指南

## 什么时候使用

只有在 Trace 导出、运行统计或组织级工具拒绝规则不能由现有配置完成时才使用扩展。业务工具应继续使用稳定 Tool API；业务 Workflow 应继续写在配置中。

## 最小 deny-policy

```ts
import { CoreMindRuntime, createDenyPolicyExtension } from "coremind-ai";

const extension = createDenyPolicyExtension({
  id: "deny-shell",
  deniedTools: ["bash"],
});

const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  lifecycleExtensions: {
    extensions: [extension],
    trustedIds: [extension.id],
    grants: { [extension.id]: extension.capabilities },
    timeoutMs: 500,
  },
});
```

该策略只能在通用权限已经允许后再拒绝 `bash`；它不能把原本被拒绝的工具改为允许。

## Trace exporter

```ts
import { createTraceExporterExtension } from "coremind-ai";

const exported: unknown[] = [];
const exporter = createTraceExporterExtension({
  id: "local-trace-exporter",
  exporter: async (event) => exported.push(event),
});
```

不要在 exporter 中放长耗时业务。设置短超时，失败后依据 `result.extensions` 排查；Runtime 的 `outcome` 仍是唯一真实终态。

## 验证

```powershell
npx vitest run packages/coremind-runtime/src/lifecycle-extension.test.ts packages/coremind-runtime/src/runtime.test.ts
npm run check:modules
```

发布前还要在 Windows 和 Linux 各验证同步、异步、超时、异常、审批拒绝、Checkpoint 顺序和中止终态。
