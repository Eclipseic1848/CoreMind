import { describe, expect, it } from "vitest";
import {
  createDenyPolicyExtension,
  createTraceExporterExtension,
  defineLifecycleExtension,
  LifecycleExtensionError,
  LifecycleExtensionHost,
} from "./lifecycle-extension.js";

const noCapabilities = {
  files: "none",
  process: false,
  network: false,
  credentials: false,
  ui: false,
} as const;

describe("LifecycleExtensionHost", () => {
  it("只加载显式信任且能力获批的扩展", () => {
    const extension = defineLifecycleExtension({
      id: "trace-exporter",
      version: "1.0.0",
      capabilities: noCapabilities,
      handlers: {},
    });

    expect(
      () =>
        new LifecycleExtensionHost({
          extensions: [extension],
          trustedIds: [],
          grants: {},
        }),
    ).toThrowError(expect.objectContaining({ code: "extension_not_trusted" }));
  });

  it("按稳定顺序执行 handler，并完整隐藏无凭据权限扩展可见的敏感值", async () => {
    const observed: string[] = [];
    const sync = defineLifecycleExtension({
      id: "sync",
      version: "1.0.0",
      capabilities: noCapabilities,
      handlers: {
        "before-model": ({ payload }) => {
          observed.push(`sync:${JSON.stringify(payload)}`);
        },
      },
    });
    const asyncExtension = defineLifecycleExtension({
      id: "async",
      version: "1.0.0",
      capabilities: noCapabilities,
      handlers: {
        "before-model": async () => {
          await Promise.resolve();
          observed.push("async");
        },
      },
    });
    const host = trustedHost([asyncExtension, sync]);

    const result = await host.dispatch("before-model", {
      prompt: "hello",
      apiKey: "secret-value",
      cookie: "session=private-cookie",
      privateKey: "PRIVATE KEY",
      endpoint: "https://user:pass@example.com/run?token=url-secret&mode=safe",
      command: "curl --password command-secret https://example.com?apiKey=query-secret",
    });

    expect(result.receipts.map((item) => item.extensionId)).toEqual(["async", "sync"]);
    expect(result.receipts.every((item) => item.status === "succeeded")).toBe(true);
    const payload = observed.find((item) => item.startsWith("sync:")) ?? "";
    expect(payload).not.toContain("secret-value");
    expect(payload).not.toContain("private-cookie");
    expect(payload).not.toContain("PRIVATE KEY");
    expect(payload).not.toContain("url-secret");
    expect(payload).not.toContain("command-secret");
    expect(payload).not.toContain("query-secret");
    expect(payload).toContain("mode=safe");
  });

  it("超时和异常被记录，不会向 Runtime 抛出或伪造结果", async () => {
    const timeout = defineLifecycleExtension({
      id: "timeout",
      version: "1.0.0",
      capabilities: noCapabilities,
      handlers: { "after-tool": () => new Promise(() => {}) },
    });
    const failed = defineLifecycleExtension({
      id: "failed",
      version: "1.0.0",
      capabilities: noCapabilities,
      handlers: {
        "after-tool": () => {
          throw new Error("boom");
        },
      },
    });
    const host = trustedHost([timeout, failed], 5);

    const result = await host.dispatch("after-tool", { tool: "read" });

    expect(result.receipts.map((item) => item.status).sort()).toEqual(["failed", "timed_out"]);
    expect(result.denied).toBeUndefined();
  });

  it("before-tool 只允许附加拒绝，不能返回 allow 覆盖通用权限", async () => {
    const deny = createDenyPolicyExtension({
      id: "deny-shell",
      deniedTools: ["bash"],
    });
    const host = trustedHost([deny]);

    expect((await host.dispatch("before-tool", { tool: "bash" })).denied).toMatchObject({
      extensionId: "deny-shell",
    });
    expect((await host.dispatch("before-tool", { tool: "read" })).denied).toBeUndefined();
  });

  it("Trace exporter 样例接收四种只读事件", async () => {
    const exported: string[] = [];
    const extension = createTraceExporterExtension({
      id: "export",
      exporter: (event) => exported.push(event.type),
    });
    const host = trustedHost([extension]);

    for (const type of ["before-model", "before-tool", "after-tool", "run-finished"] as const) {
      await host.dispatch(type, { marker: type });
    }

    expect(exported).toEqual(["before-model", "before-tool", "after-tool", "run-finished"]);
  });

  it("拒绝重复 id 和超出 capability grant 的扩展", () => {
    const extension = defineLifecycleExtension({
      id: "networked",
      version: "1.0.0",
      capabilities: { ...noCapabilities, network: true },
      handlers: {},
    });
    expect(
      () =>
        new LifecycleExtensionHost({
          extensions: [extension],
          trustedIds: ["networked"],
          grants: { networked: noCapabilities },
        }),
    ).toThrowError(expect.objectContaining({ code: "extension_capability_denied" }));
    expect(
      () =>
        new LifecycleExtensionHost({
          extensions: [extension, extension],
          trustedIds: ["networked"],
          grants: { networked: { ...noCapabilities, network: true } },
        }),
    ).toThrow(LifecycleExtensionError);
  });
});

function trustedHost(
  extensions: ReturnType<typeof defineLifecycleExtension>[],
  timeoutMs = 100,
): LifecycleExtensionHost {
  return new LifecycleExtensionHost({
    extensions,
    trustedIds: extensions.map((item) => item.id),
    grants: Object.fromEntries(extensions.map((item) => [item.id, item.capabilities])),
    timeoutMs,
  });
}
