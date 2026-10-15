import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileRunStore } from "coremind-ai";
import { PROTOCOL_V2_SCHEMA_FINGERPRINT } from "coremind-protocol";
import { describe, expect, it, vi } from "vitest";
import { ProtocolHost } from "./server.js";

const challenge = {
  schemaVersion: 1,
  requiredCapabilities: ["toolDiscovery"],
  retryInitialize: true,
};

describe("Worker 工具发现初始化门", () => {
  it("v1 先返回精确挑战，零 Provider/Runtime/RunStore，再在同宿主接受受限重发", async () => {
    await fixture(async ({ host, directory, resolve, createRuntime, createStore }) => {
      const params = initializeParams(directory, true);
      expect(await host.handle(request(params))).toMatchObject({
        error: { data: { coremindCode: "protocol_capability_missing", details: challenge } },
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(createStore).not.toHaveBeenCalled();
      expect(
        await host.handle({ jsonrpc: "2.0", id: "run-before-cap", method: "run", params: {} }),
      ).toMatchObject({
        error: { data: { coremindCode: "not_initialized" } },
      });
      const response = await host.handle(
        request({ ...params, capabilities: ["toolDiscovery"] }, "retry"),
      );
      expect(response).toMatchObject({
        result: { protocolVersion: "1.0", capabilities: expect.arrayContaining(["toolDiscovery"]) },
      });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(createStore).toHaveBeenCalledTimes(1);
      expect(createRuntime).not.toHaveBeenCalled();
    });
  });

  it("旧 v1 不增加能力要求或回执，Config 3 direct 也不要求新语义", async () => {
    for (const schemaVersion of [2, 3]) {
      await fixture(async ({ host, directory, resolve }) => {
        const params = initializeParams(directory, false, schemaVersion);
        const response = await host.handle(request(params));
        expect(response).toMatchObject({ result: { protocolVersion: "1.0" } });
        if (!("result" in response)) throw new Error("初始化失败");
        expect((response.result as { capabilities: string[] }).capabilities).not.toContain(
          "toolDiscovery",
        );
        expect(resolve).toHaveBeenCalledTimes(1);
      });
    }
  });

  it("Config 2 deferred 静态拒绝，不伪装成可重试挑战", async () => {
    await fixture(async ({ host, directory, resolve, createStore }) => {
      const response = await host.handle(request(initializeParams(directory, true, 2)));
      expect(response).toMatchObject({ error: { data: { coremindCode: "invalid_config" } } });
      expect(JSON.stringify(response)).not.toContain("retryInitialize");
      expect(resolve).not.toHaveBeenCalled();
      expect(createStore).not.toHaveBeenCalled();
    });
  });

  it("v2 未协商能力时不初始化，也不发 v1 重试挑战", async () => {
    await fixture(async ({ host, directory, resolve, createRuntime, createStore }) => {
      const { protocolVersion: _version, ...params } = initializeParams(directory, true);
      const response = await host.handle(
        request({
          ...params,
          protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
          capabilities: [],
        }),
      );
      expect(response).toMatchObject({
        error: { data: { coremindCode: "protocol_capability_missing" } },
      });
      expect(JSON.stringify(response)).not.toContain("retryInitialize");
      expect(resolve).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(createStore).not.toHaveBeenCalled();
    });
  });

  it("v2 能力经内部 v1 转换保留，回执绑定当前精确指纹", async () => {
    await fixture(async ({ host, directory, resolve, createRuntime }) => {
      const { protocolVersion: _version, ...params } = initializeParams(directory, true);
      expect(
        await host.handle(
          request({
            ...params,
            protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
            capabilities: ["toolDiscovery"],
          }),
        ),
      ).toMatchObject({
        result: {
          selectedProtocol: "2.0",
          schemaFingerprint: PROTOCOL_V2_SCHEMA_FINGERPRINT,
          serverCapabilities: expect.arrayContaining(["toolDiscovery"]),
        },
      });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(createRuntime).not.toHaveBeenCalled();
    });
  });

  it("v2 仅在客户端声明时回执 toolDiscovery", async () => {
    await fixture(async ({ host, directory }) => {
      const { protocolVersion: _version, ...params } = initializeParams(directory, false, 2);
      const response = await host.handle(
        request({
          ...params,
          protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
          capabilities: [],
        }),
      );
      expect(response).toMatchObject({ result: { selectedProtocol: "2.0" } });
      if (!("result" in response)) throw new Error("初始化失败");
      expect(
        (response.result as { serverCapabilities: string[] }).serverCapabilities,
      ).not.toContain("toolDiscovery");
    });
  });
});

function request(params: object, id = "initialize") {
  return { jsonrpc: "2.0", id, method: "initialize", params };
}

function initializeParams(directory: string, deferred: boolean, schemaVersion = 3) {
  return {
    protocolVersion: "1.0",
    configDir: directory,
    config: {
      schemaVersion,
      name: "worker-discovery-protocol",
      provider: {
        id: "gateway",
        baseUrl: "http://127.0.0.1:9/v1",
        model: "fixture",
        apiKeySecretRef: { secretRef: "opaque/discovery-test" },
      },
      agents: { main: { tools: [{ id: "read", ...(deferred ? { exposure: "deferred" } : {}) }] } },
    },
  };
}

async function fixture(
  check: (value: {
    host: ProtocolHost;
    directory: string;
    resolve: ReturnType<typeof vi.fn>;
    createRuntime: ReturnType<typeof vi.fn>;
    createStore: ReturnType<typeof vi.fn>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-protocol-"));
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
  try {
    await check({ host, directory, resolve, createRuntime, createStore });
  } finally {
    await host.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
}
