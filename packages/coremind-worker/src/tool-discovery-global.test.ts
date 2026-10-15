import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRunStore } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { ProtocolHost } from "./server.js";

it.each([
  { name: "省略 Agent tools 继承全局 deferred", tools: undefined, requiresCapability: true },
  { name: "空 Agent tools 回退全局 deferred", tools: [], requiresCapability: true },
  {
    name: "显式 direct 覆盖全局 deferred",
    tools: [{ id: "read", exposure: "direct" }],
    requiresCapability: false,
  },
])("$name", async ({ tools, requiresCapability }) => {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-global-"));
  const resolve = vi.fn(async () => "test-only");
  const createRuntime = vi.fn(async () => {
    throw new Error("初始化不得创建 Runtime");
  });
  const createStore = vi.fn((location: string) => new FileRunStore(location));
  const host = new ProtocolHost({
    send: () => {},
    secretResolver: { resolve },
    runtimeFactory: createRuntime,
    runStoreFactory: createStore,
  });
  const params = {
    protocolVersion: "1.0",
    configDir: directory,
    config: {
      schemaVersion: 3,
      name: "全局工具继承能力门",
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "fixture",
        apiKeySecretRef: { secretRef: "opaque/discovery-global-test" },
      },
      tools: [{ id: "read", exposure: "deferred" }],
      agents: { main: tools === undefined ? {} : { tools } },
    },
  };
  try {
    const response = await host.handle({
      jsonrpc: "2.0",
      id: "first",
      method: "initialize",
      params,
    });
    if (requiresCapability) {
      expect(response).toHaveProperty("error.data.coremindCode", "protocol_capability_missing");
      expect(response).toHaveProperty("error.data.details", {
        schemaVersion: 1,
        requiredCapabilities: ["toolDiscovery"],
        retryInitialize: true,
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(createStore).not.toHaveBeenCalled();
      expect(
        await host.handle({
          jsonrpc: "2.0",
          id: "retry",
          method: "initialize",
          params: { ...params, capabilities: ["toolDiscovery"] },
        }),
      ).toMatchObject({ result: { capabilities: expect.arrayContaining(["toolDiscovery"]) } });
    } else {
      expect(response).toHaveProperty("result");
      if (!("result" in response)) throw new Error("显式 direct 覆盖不应被能力门误拦");
      expect((response.result as { capabilities: string[] }).capabilities).not.toContain(
        "toolDiscovery",
      );
    }
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(createStore).toHaveBeenCalledTimes(1);
    expect(createRuntime).not.toHaveBeenCalled();
  } finally {
    await host.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
