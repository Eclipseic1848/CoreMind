import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpHttpTransport, isMcpHttpFatalError } from "./mcp-http-transport.js";

const sdkConstruction = vi.hoisted(() => ({
  options: undefined as ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
}));

vi.mock("@modelcontextprotocol/client", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@modelcontextprotocol/client")>();
  return {
    ...sdk,
    StreamableHTTPClientTransport: class extends sdk.StreamableHTTPClientTransport {
      constructor(...args: ConstructorParameters<typeof sdk.StreamableHTTPClientTransport>) {
        super(...args);
        sdkConstruction.options = args[1];
      }
    },
  };
});

const environment = () =>
  createFakeExecutionEnvironment({
    claimed: { networkEgress: "unrestricted" },
    observed: { networkEgress: "unrestricted" },
  });

it("原生 Streamable HTTP 通过受控 fetch 建立 session，close 不发送 DELETE", async () => {
  const service = await startMcpHttpServer();
  const runEnvironment = environment();
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment,
  });
  const messages: unknown[] = [];
  transport.onmessage = (message) => messages.push(message);
  try {
    expect(runEnvironment.isQuiescent()).toBe(true);
    expect(service.records.filter((record) => record.type === "http")).toHaveLength(0);
    await transport.start();
    expect(service.records.filter((record) => record.type === "http")).toHaveLength(0);
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(messages).toEqual([
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({ serverInfo: { name: "http-fixture", version: "1.0.0" } }),
      }),
    ]);
    expect(transport.sessionId).toBe("fixture-session");
    expect(transport.environmentSummary).toMatchObject({
      networkEgress: "adapter_scoped",
      processControl: "none",
      credentialIsolation: "none",
    });
    await transport.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    expect(runEnvironment.isQuiescent()).toBe(true);
    expect(service.records.some((record) => record.method === "DELETE")).toBe(false);
  } finally {
    await transport.close();
    await service.close();
  }
});

it("成功短 SSE EOF 的 GET 恢复仍共享 owner 三次总预算", async () => {
  const service = await startMcpHttpServer({ mode: "short-stream" });
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
  });
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  try {
    await transport.start();
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await vi.waitFor(() => expect(errors.some(isMcpHttpFatalError)).toBe(true));
    await transport.close();
    expect(
      service.records.filter((record) => record.type === "http" && record.method === "GET"),
    ).toHaveLength(3);
    expect(
      service.records.filter((record) => record.type === "http" && record.method === "POST"),
    ).toHaveLength(1);
  } finally {
    await transport.close();
    await service.close();
  }
});

it("真实 SSE socket 断流仅恢复 GET，保持会话与 Last-Event-ID 且不误杀 owner", async () => {
  const service = await startMcpHttpServer({ mode: "drop-stream-once" });
  const runEnvironment = environment();
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment,
  });
  const messages: unknown[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => {
    errors.push(error);
    if (isMcpHttpFatalError(error)) void transport.close();
  };
  try {
    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({ params: { uri: "fixture://before-drop" } }),
      ),
    );
    service.dropStreams();
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({ params: { uri: "fixture://resumed" } }),
      ),
    );
    const gets = service.records.filter(
      (record) => record.type === "http" && record.method === "GET",
    );
    expect(gets).toHaveLength(2);
    expect(gets[1]).toMatchObject({ sessionMatched: true, resumptionMatched: true });
    expect(
      service.records.filter((record) => record.type === "http" && record.method === "POST"),
    ).toHaveLength(2);
    expect(errors.some(isMcpHttpFatalError)).toBe(false);
    expect(runEnvironment.isQuiescent()).toBe(false);
    await transport.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    expect(runEnvironment.isQuiescent()).toBe(true);
  } finally {
    await transport.close();
    await service.close();
  }
});

it("GET 断流时不完整 UTF-8 仍是致命协议错误，不能转成有效 EOF 恢复", async () => {
  const service = await startMcpHttpServer({ mode: "drop-stream-invalid-utf8" });
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
  });
  const messages: unknown[] = [];
  const errors: Error[] = [];
  transport.onmessage = (message) => messages.push(message);
  transport.onerror = (error) => {
    errors.push(error);
    if (isMcpHttpFatalError(error)) void transport.close();
  };
  try {
    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({ params: { uri: "fixture://before-drop" } }),
      ),
    );
    service.dropStreams();
    await vi.waitFor(() => expect(errors.some(isMcpHttpFatalError)).toBe(true));
    await transport.close();
    expect(
      service.records.filter((record) => record.type === "http" && record.method === "GET"),
    ).toHaveLength(1);
  } finally {
    await transport.close();
    await service.close();
  }
});

it("close 清理官方 scheduler 创建的所有句柄，不依赖 SDK 仅保留的最后一项", async () => {
  const transport = createMcpHttpTransport({
    url: "https://example.com/mcp",
    headers: {},
    runEnvironment: environment(),
  });
  await transport.start();
  vi.useFakeTimers();
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  const reconnect = vi.fn();
  try {
    const scheduler = sdkConstruction.options?.reconnectionScheduler;
    if (!scheduler) throw new Error("官方 HTTP transport 未收到受控恢复 scheduler");
    scheduler(reconnect, 777, 0);
    scheduler(reconnect, 777, 0);
    expect(scheduled).toHaveBeenCalledTimes(2);
    const handles = scheduled.mock.results.map((result) => result.value);
    await transport.close();
    for (const handle of handles) expect(cleared).toHaveBeenCalledWith(handle);
    vi.runAllTimers();
    expect(reconnect).not.toHaveBeenCalled();
  } finally {
    await transport.close();
    vi.clearAllTimers();
    scheduled.mockRestore();
    cleared.mockRestore();
    vi.useRealTimers();
  }
});

it.each(["cancel-status-500", "cancel-status-405"])(
  "%s 的取消通知失败不影响其他合法请求",
  async (mode) => {
    const service = await startMcpHttpServer({ mode });
    const transport = createMcpHttpTransport({
      url: service.url,
      headers: {},
      allowedAddresses: ["127.0.0.1"],
      runEnvironment: environment(),
    });
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);
    try {
      await transport.start();
      await transport.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      const calling = transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { value: false } },
      });
      const cancelled = expect(calling).rejects.toMatchObject({ code: "mcp_request_cancelled" });
      await vi.waitFor(() =>
        expect(
          service.records.some(
            (record) => record.type === "request" && record.method === "tools/call",
          ),
        ).toBe(true),
      );
      await expect(
        transport.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
      ).resolves.toBeUndefined();
      await cancelled;
      await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(errors.some(isMcpHttpFatalError)).toBe(false);
      expect(
        service.records.filter(
          (record) => record.type === "request" && record.method === "tools/call",
        ),
      ).toHaveLength(1);
      expect(
        service.records.some(
          (record) => record.type === "request" && record.method === "tools/list",
        ),
      ).toBe(true);
    } finally {
      await transport.close();
      await service.close();
    }
  },
);

it("SSE headers 后取消释放请求占位，其他流与后续合法请求不受影响", async () => {
  const service = await startMcpHttpServer({ mode: "sse-hang-call" });
  const runEnvironment = environment();
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment,
  });
  const first = new AbortController();
  const second = new AbortController();
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  try {
    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    await transport.send(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { value: false } },
      },
      { requestSignal: first.signal },
    );
    await transport.send(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { value: null } },
      },
      { requestSignal: second.signal },
    );
    first.abort();
    await vi.waitFor(() =>
      expect(service.records).toContainEqual({ type: "response-closed", id: 2 }),
    );
    expect(service.records).not.toContainEqual({ type: "response-closed", id: 3 });
    expect(runEnvironment.isQuiescent()).toBe(false);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(errors.some(isMcpHttpFatalError)).toBe(false);
    second.abort();
    await transport.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    expect(runEnvironment.isQuiescent()).toBe(true);
  } finally {
    first.abort();
    second.abort();
    await transport.close();
    await service.close();
  }
});

it.each([
  "unauthorized",
  "forbidden",
  "error-secret",
  "status-408",
  "status-421",
  "status-429",
  "status-503",
])("SDK %s 错误安全且不会自动重发 POST", async (mode) => {
  const secret = "http-error-private-87012";
  const service = await startMcpHttpServer({ mode, secret });
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
    sensitiveValues: [secret],
  });
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  try {
    await transport.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toMatchObject({
      code:
        mode === "unauthorized" || mode === "forbidden"
          ? "mcp_http_auth_required"
          : "mcp_http_status_error",
    });
    expect(errors.map(String).join("\n")).not.toContain(secret);
    expect(errors.some(isMcpHttpFatalError)).toBe(false);
    expect(service.records.filter((record) => record.type === "http")).toHaveLength(1);
  } finally {
    await transport.close();
    await service.close();
  }
});

it("写后丢失响应的 POST 只发送一次且不伪报成功", async () => {
  const service = await startMcpHttpServer({ mode: "write-drop" });
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
  });
  transport.onerror = () => {};
  try {
    await transport.start();
    await transport.send({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    await expect(
      transport.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { value: false } },
      }),
    ).rejects.toMatchObject({ code: "mcp_http_request_failed" });
    expect(service.records.filter((record) => record.type === "effect")).toHaveLength(1);
    expect(
      service.records.filter((record) => record.type === "http" && record.method === "POST"),
    ).toHaveLength(2);
  } finally {
    await transport.close();
    await service.close();
  }
});

it.each(["bad-json", "invalid-utf8"])("%s 是安全的致命协议失败", async (mode) => {
  const service = await startMcpHttpServer({ mode });
  const transport = createMcpHttpTransport({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
  });
  const errors: Error[] = [];
  transport.onerror = (error) => errors.push(error);
  try {
    await transport.start();
    await expect(transport.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toMatchObject({
      code: "mcp_protocol_error",
    });
    expect(errors.some(isMcpHttpFatalError)).toBe(true);
  } finally {
    await transport.close();
    await service.close();
  }
});

it.each(["deadline", "legacy-notification"])(
  "%s 只取消对应请求，其他调用仍可完成",
  async (mode) => {
    const service = await startMcpHttpServer({ mode: "hang-call" });
    const transport = createMcpHttpTransport({
      url: service.url,
      headers: {},
      allowedAddresses: ["127.0.0.1"],
      runEnvironment: environment(),
    });
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);
    try {
      await transport.start();
      await transport.send({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      });
      const calling = transport.send(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { value: false } },
        },
        mode === "deadline" ? { requestSignal: AbortSignal.timeout(250) } : undefined,
      );
      const cancelled = expect(calling).rejects.toMatchObject({ code: "mcp_request_cancelled" });
      await vi.waitFor(() =>
        expect(
          service.records.some(
            (record) => record.type === "request" && record.method === "tools/call",
          ),
        ).toBe(true),
      );
      if (mode === "legacy-notification")
        await transport.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1, reason: "不应传播的任意原因" },
        });
      await cancelled;
      await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(errors.some(isMcpHttpFatalError)).toBe(false);
      expect(
        service.records.filter(
          (record) => record.type === "request" && record.method === "tools/call",
        ),
      ).toHaveLength(1);
      expect(
        service.records.some(
          (record) => record.type === "request" && record.method === "tools/list",
        ),
      ).toBe(true);
    } finally {
      await transport.close();
      await service.close();
    }
  },
);
