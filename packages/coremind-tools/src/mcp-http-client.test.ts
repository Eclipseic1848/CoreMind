import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JSONRPCMessage, JSONRPCRequest, Transport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpHttpClient, type McpHttpClient } from "./mcp-http-client.js";
import { McpStdioError } from "./mcp-stdio-transport.js";

const transportFactory = vi.hoisted(() => vi.fn());
vi.mock("./mcp-http-transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./mcp-http-transport.js")>()),
  createMcpHttpTransport: transportFactory,
}));

const allowed = "docs://workspace/approved";
const denied = "docs://workspace/forbidden";
const hold = Symbol("等待本次请求取消");
const clients: McpHttpClient[] = [];
const directories: string[] = [];

beforeEach(() => transportFactory.mockReset());
afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  } finally {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  }
});

it("HTTP 工厂零 I/O，默认空资源集合在任何协议请求前拒绝", async () => {
  const { client, transport } = await setup([]);
  expect(transport.started).toBe(0);
  expect(client.environmentSummary).toBeUndefined();
  await expect(client.listResources()).rejects.toMatchObject({ code: "mcp_resource_not_allowed" });
  await expect(client.listResourceTemplates()).rejects.toMatchObject({
    code: "mcp_resource_not_allowed",
  });
  await expect(client.readResource(allowed)).rejects.toMatchObject({
    code: "mcp_resource_not_allowed",
  });
  expect(transport.messages).toEqual([]);
});

it("资源按需分页并只展示精确 URI 及匹配模板，模板不扩大读取授权", async () => {
  const { client, transport } = await setup([allowed], (request) => {
    if (request.method === "resources/list")
      return request.params?.cursor === "second"
        ? { resources: [{ uri: denied, name: "未选资源" }] }
        : { resources: [{ uri: allowed, name: "已选资源" }], nextCursor: "second" };
    return undefined;
  });
  await client.connect();
  expect(transport.messages.some((request) => request.method.startsWith("resources/"))).toBe(false);
  expect(client.environmentSummary).toMatchObject({
    processControl: "none",
    networkEgress: "adapter_scoped",
  });
  expect((await client.listResources()).details).toEqual({
    mcp: { resources: [{ uri: allowed, name: "已选资源" }] },
  });
  expect((await client.listResourceTemplates()).details).toEqual({
    mcp: { resourceTemplates: [{ name: "工作区模板", uriTemplate: "docs://workspace/{name}" }] },
  });
  const before = transport.messages.length;
  await expect(client.readResource(denied)).rejects.toMatchObject({
    code: "mcp_resource_not_allowed",
  });
  await expect(client.readResource("docs://workspace/%61pproved")).rejects.toMatchObject({
    code: "mcp_resource_not_allowed",
  });
  expect(transport.messages).toHaveLength(before);
  expect((await client.readResource(allowed)).details).toEqual({
    mcp: { contents: [{ uri: allowed, mimeType: "application/json", text: "false" }] },
  });
  const pages = transport.messages.filter((request) => request.method === "resources/list");
  expect(pages).toHaveLength(2);
  expect(pages[0]!.params?.cursor).toBeUndefined();
  expect(pages[1]!.params?.cursor).toBe("second");
});

it.each(["uri", "blob"])("资源响应的 %s 边界不能被服务器扩权", async (mode) => {
  const { client, transport } = await setup([allowed], (request) =>
    request.method === "resources/read"
      ? {
          contents: [
            mode === "uri" ? { uri: denied, text: "未授权正文" } : { uri: allowed, blob: "AA==" },
          ],
        }
      : undefined,
  );
  await client.connect();
  await expect(client.readResource(allowed)).rejects.toMatchObject({
    code: mode === "uri" ? "mcp_protocol_error" : "mcp_unsupported_content",
  });
  expect(transport.messages.filter((request) => request.method === "resources/read")).toHaveLength(
    1,
  );
  if (mode === "uri") expect(transport.closed).toBe(1);
});

it.each(["cursor", "pages", "items", "bytes", "depth"])(
  "资源目录 %s 超限失败关闭",
  async (mode) => {
    let count = 0;
    const { client, transport } = await setup([allowed], (request) => {
      if (request.method !== "resources/list") return undefined;
      count++;
      if (mode === "cursor" || mode === "pages")
        return { resources: [], nextCursor: mode === "cursor" ? "same" : String(count) };
      if (mode === "items")
        return {
          resources: Array.from({ length: 257 }, (_, index) => ({
            uri: `${allowed}/${index}`,
            name: String(index),
          })),
        };
      if (mode === "bytes")
        return {
          resources: [{ uri: allowed, name: "过大目录", description: "x".repeat(8 * 1024 * 1024) }],
        };
      let nested: unknown = null;
      for (let index = 0; index < 66; index++) nested = { nested };
      return { resources: [{ uri: allowed, name: "深层目录", _meta: { nested } }] };
    });
    await client.connect();
    await expect(client.listResources()).rejects.toMatchObject({
      code: mode === "cursor" ? "mcp_invalid_directory" : "mcp_output_limit",
    });
    expect(count).toBeLessThanOrEqual(32);
    expect(transport.closed).toBe(1);
  },
);

it("单资源等待者取消不关闭 HTTP owner，其它工具仍使用原快照调用", async () => {
  const entered = deferred<void>();
  const { client, transport } = await setup([allowed], (request) => {
    if (request.method === "resources/read") {
      entered.resolve();
      return hold;
    }
    return undefined;
  });
  await client.connect();
  const tool = (await client.listTools())[0]!;
  const controller = new AbortController();
  const reading = client.readResource(allowed, controller.signal);
  const rejected = expect(reading).rejects.toHaveProperty("code");
  await entered.promise;
  controller.abort(new Error("不能回显的取消原因"));
  await rejected;
  expect(transport.closed).toBe(0);
  expect((await client.callTool(tool, { value: false })).details).toEqual({
    mcp: { content: [{ type: "text", text: "完成" }], structuredContent: { result: false } },
  });
  expect(transport.messages.filter((request) => request.method === "tools/call")).toHaveLength(1);
});

it.each(["mcp_http_auth_required", "mcp_http_status_error", "mcp_http_request_failed"])(
  "HTTP %s 不重发业务，也不关闭其它请求",
  async (code) => {
    let failed = false;
    const { client, transport } = await setup([allowed], (request) => {
      if (request.method === "resources/read" && !failed) {
        failed = true;
        throw new McpStdioError(code, "受控安全网络错误");
      }
      return undefined;
    });
    await client.connect();
    await expect(client.readResource(allowed)).rejects.toMatchObject({ code });
    expect(
      transport.messages.filter((request) => request.method === "resources/read"),
    ).toHaveLength(1);
    expect(transport.closed).toBe(0);
    expect((await client.readResource(allowed)).details).toHaveProperty("mcp.contents");
  },
);

it("首个连接等待者取消不拥有共享握手，第二等待者仍可完成", async () => {
  const { client, transport } = await setup([allowed]);
  const entered = deferred<void>();
  let handshake: JSONRPCRequest | undefined;
  const respond = transport.respond.bind(transport);
  transport.respond = (request, result) => {
    if (request.method === "initialize") {
      handshake = request;
      entered.resolve();
    } else respond(request, result);
  };
  const controller = new AbortController();
  const first = client.connect(controller.signal);
  const rejected = expect(first).rejects.toMatchObject({ code: "mcp_request_cancelled" });
  await entered.promise;
  const second = client.connect();
  controller.abort();
  await rejected;
  expect(transport.closed).toBe(0);
  respond(handshake!, {
    protocolVersion: handshake!.params?.protocolVersion,
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: "protocol-fixture", version: "1" },
  });
  await second;
  expect(transport.messages.filter((request) => request.method === "initialize")).toHaveLength(1);
  expect((await client.listTools())[0]!.name).toBe("echo");
});

it("资源页共享三十秒总期限，不能每页重新获得完整期限", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  let firstRequest: JSONRPCRequest | undefined;
  const { client, transport } = await setup([allowed], (request) => {
    if (request.method !== "resources/list") return undefined;
    if (request.params?.cursor === "second") second.resolve();
    else {
      firstRequest = request;
      first.resolve();
    }
    return hold;
  });
  await client.connect();
  vi.useFakeTimers();
  try {
    const listing = client.listResources();
    const rejected = expect(listing).rejects.toHaveProperty("code");
    await first.promise;
    await vi.advanceTimersByTimeAsync(20_000);
    transport.respond(firstRequest!, { resources: [], nextCursor: "second" });
    await second.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(transport.closed).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("资源秘密先阻断，较大安全正文沿同一真实 Artifact 字节路径", async () => {
  const secret = "http-resource-private-73629";
  let text = secret;
  const { client, transport, directory } = await setup(
    [allowed],
    (request) =>
      request.method === "resources/read" ? { contents: [{ uri: allowed, text }] } : undefined,
    [secret],
  );
  await client.connect();
  await expect(client.readResource(allowed)).rejects.toMatchObject({ code: "mcp_secret_blocked" });
  expect(transport.closed).toBe(1);
  text = "安全正文".repeat(5_000);
  const safe = await setup([allowed], (request) =>
    request.method === "resources/read" ? { contents: [{ uri: allowed, text }] } : undefined,
  );
  await safe.client.connect();
  const result = await safe.client.readResource(allowed);
  const details = result.details as { artifact: { relativePath: string } };
  const stored = JSON.parse(
    await readFile(path.join(safe.directory, details.artifact.relativePath), "utf8"),
  );
  expect(stored).toEqual({ mcp: { contents: [{ uri: allowed, text }] } });
  expect(result.text).toContain("Artifact:");
  expect(result.text).not.toContain(directory);
});

async function setup(
  uris: readonly string[],
  reply?: (request: JSONRPCRequest) => unknown,
  sensitiveValues: string[] = [],
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-http-client-"));
  directories.push(directory);
  const transport = new ProtocolFixture(reply);
  transportFactory.mockReturnValueOnce(transport);
  const client = createMcpHttpClient({
    url: "https://mcp.example.invalid/rpc",
    headers: {},
    allowedResourceUris: uris,
    runEnvironment: createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    }),
    sensitiveValues,
    artifactStore: new ArtifactStore({ cwd: directory }),
  });
  clients.push(client);
  return { client, transport, directory };
}

// 仅替代 Transport 边界；握手、请求、取消、分页和响应校验均由实际 SDK Client 执行。
class ProtocolFixture implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  readonly hasPerRequestStream = true;
  readonly messages: JSONRPCRequest[] = [];
  started = 0;
  closed = 0;
  environmentSummary:
    | {
        isolation: "trusted_host";
        processControl: "none";
        networkEgress: "adapter_scoped";
        credentialIsolation: "none";
        platform: NodeJS.Platform;
        evidence: string[];
      }
    | undefined;
  constructor(private readonly reply?: (request: JSONRPCRequest) => unknown) {}
  async start() {
    this.started++;
    this.environmentSummary = {
      isolation: "trusted_host",
      processControl: "none",
      networkEgress: "adapter_scoped",
      credentialIsolation: "none",
      platform: process.platform,
      evidence: ["受控协议夹具"],
    };
  }
  async send(message: JSONRPCMessage) {
    if (!("method" in message) || !("id" in message)) return;
    this.messages.push(message);
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: { listChanged: true }, resources: {} },
            serverInfo: { name: "protocol-fixture", version: "1" },
          }
        : (this.reply?.(message) ?? defaultReply(message));
    if (result !== hold) this.respond(message, result);
  }
  respond(request: JSONRPCRequest, result: unknown) {
    queueMicrotask(() =>
      this.onmessage?.({ jsonrpc: "2.0", id: request.id, result } as JSONRPCMessage),
    );
  }
  async close() {
    if (!this.closed++) this.onclose?.();
  }
}

function defaultReply(request: JSONRPCRequest) {
  if (request.method === "tools/list")
    return {
      tools: [{ name: "echo", inputSchema: { type: "object", properties: { value: {} } } }],
    };
  if (request.method === "tools/call")
    return {
      content: [{ type: "text", text: "完成" }],
      structuredContent: {
        result: request.params?.arguments && (request.params.arguments as { value: unknown }).value,
      },
    };
  if (request.method === "resources/templates/list")
    return {
      resourceTemplates: [
        { name: "工作区模板", uriTemplate: "docs://workspace/{name}" },
        { name: "未选模板", uriTemplate: "https://elsewhere/{name}" },
      ],
    };
  if (request.method === "resources/read")
    return {
      contents: [{ uri: request.params?.uri, mimeType: "application/json", text: "false" }],
    };
  return { resources: [] };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
