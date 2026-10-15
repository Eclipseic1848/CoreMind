import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpHttpClient } from "./mcp-http-client.js";
import { createMcpHttpFetch } from "./mcp-http-fetch.js";

const secret = "integration-http-private-836172";
const uris = ["fixture://first", "fixture://first/item"];

it.each(["legacy", "2026-07-28"] as const)(
  "%s 的真实 HTTP 连接按需完成资源两页、模板两页与精确读取",
  async (protocolVersion) => {
    await withClient("normal", protocolVersion, async ({ client, service }) => {
      await client.connect();
      const tool = (await client.listTools())[0]!;
      expect(requests(service, "resources/list")).toEqual([]);
      expect(requests(service, "resources/templates/list")).toEqual([]);
      expect(requests(service, "resources/read")).toEqual([]);

      const listed = await client.listResources();
      expect(listed.details).toEqual({
        mcp: {
          resources: [{ uri: "fixture://first", name: "第一资源", mimeType: "text/plain" }],
        },
      });
      const templates = await client.listResourceTemplates();
      expect(templates.details).toEqual({
        mcp: {
          resourceTemplates: [{ uriTemplate: "fixture://first/{id}", name: "第一模板" }],
        },
      });
      for (const method of ["resources/list", "resources/templates/list"]) {
        const pages = requests(service, method);
        expect(pages).toHaveLength(2);
        expect(pages[0]!.params?.cursor).toBeUndefined();
        expect(businessParams(pages[1]!)).toEqual({ cursor: "second" });
      }

      const before = requests(service, "resources/read").length;
      await expect(client.readResource("fixture://first/unselected")).rejects.toMatchObject({
        code: "mcp_resource_not_allowed",
      });
      expect(requests(service, "resources/read")).toHaveLength(before);
      expect((await client.readResource("fixture://first")).text).toBe("资源正文 false 0 null");
      expect(requests(service, "resources/read").map(businessParams)).toEqual([
        { uri: "fixture://first" },
      ]);
      const output = await client.callTool(tool, { value: [false, 0, null] });
      expect(output.text).toContain("[false,0,null]");
      expect(requests(service, "tools/call").map(businessParams)).toEqual([
        { name: "echo", arguments: { value: [false, 0, null] } },
      ]);
      expect(JSON.stringify({ listed, templates, output })).not.toContain(secret);
    });
  },
);

it.each(["legacy", "2026-07-28"] as const)(
  "%s 的同一真实 HTTP owner 慢资源目录不阻塞工具，取消目录后还能读取和调用",
  async (protocolVersion) => {
    await withClient("slow-resource-list", protocolVersion, async ({ client, service }) => {
      await client.connect();
      const tool = (await client.listTools())[0]!;
      const controller = new AbortController();
      const listing = client.listResources(controller.signal);
      const rejected = expect(listing).rejects.toMatchObject({ code: "mcp_request_cancelled" });
      try {
        await vi.waitFor(() => expect(requests(service, "resources/list")).toHaveLength(1));
        const blockedHttp = service.records
          .filter((record) => record.type === "http" && record.method === "POST")
          .at(-1)!;
        expect((await client.callTool(tool, { value: false })).text).toContain("false");
        expect(requests(service, "tools/call")).toHaveLength(1);
        expect(requests(service, "resources/read")).toEqual([]);

        controller.abort(new Error("只取消本次目录等待"));
        await rejected;
        await vi.waitFor(() =>
          expect(service.records).toContainEqual({ type: "response-closed", id: blockedHttp.id }),
        );
        expect((await client.readResource("fixture://first")).text).toBe("资源正文 false 0 null");
        expect((await client.callTool(tool, { value: 0 })).text).toContain("0");
        expect(requests(service, "resources/list")).toHaveLength(1);
        expect(requests(service, "resources/read")).toHaveLength(1);
        expect(requests(service, "tools/call")).toHaveLength(2);
        expect(
          requests(service, protocolVersion === "legacy" ? "initialize" : "server/discover"),
        ).toHaveLength(1);
        expect(service.records.some((record) => record.type === "session-rejected")).toBe(false);
      } finally {
        controller.abort();
        await Promise.allSettled([listing]);
      }
    });
  },
);

it("跨源重定向不触及第二服务，也不向目标泄漏认证 Header", async () => {
  const targetRequests: Array<{ authorized: boolean }> = [];
  const target = await listen(
    createServer((request, response) => {
      targetRequests.push({ authorized: request.headers.authorization !== undefined });
      response.end("不应抵达");
    }),
  );
  let originRequests = 0;
  let originAuthorized = false;
  const origin = await listen(
    createServer((request, response) => {
      originRequests += 1;
      originAuthorized = request.headers.authorization === `Bearer ${secret}`;
      response.writeHead(307, { location: target.url }).end();
    }),
  );
  const owner = createMcpHttpFetch({
    url: origin.url,
    headers: { authorization: `Bearer ${secret}` },
    allowedAddresses: ["127.0.0.1"],
    sensitiveValues: [secret],
    runEnvironment: environment(),
  });
  try {
    await expect(owner.fetch(origin.url, { method: "POST", body: "{}" })).rejects.toMatchObject({
      code: "mcp_http_policy_denied",
    });
    expect(originRequests).toBe(1);
    expect(originAuthorized).toBe(true);
    expect(targetRequests).toEqual([]);
    await owner.close();
    await vi.waitFor(() => expect(origin.sockets.size).toBe(0));
    expect(target.sockets.size).toBe(0);
  } finally {
    await owner.close();
    await origin.close();
    await target.close();
  }
});

it.each([false, true])(
  "只由独立子进程信任公开测试 CA，实际 HTTPS hostname 校验（wrongHost=%s）",
  async (wrongHost) => {
    const fixtureRoot = path.resolve(process.cwd(), "test/fixtures");
    // 仅用于测试互通的公开证书和私钥，不能承载生产认证或扩大宿主信任。
    const [cert, key] = await Promise.all([
      readFile(path.join(fixtureRoot, "mcp-http-test-cert.pem"), "utf8"),
      readFile(path.join(fixtureRoot, "mcp-http-test-key.pem"), "utf8"),
    ]);
    const requests: Array<{ host: string | undefined; sni: string | false | null }> = [];
    const service = await listen(
      createHttpsServer({ cert, key }, (request, response) => {
        requests.push({
          host: request.headers.host,
          sni: (request.socket as import("node:tls").TLSSocket).servername,
        });
        if (request.method === "GET") {
          response.writeHead(405).end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const message = JSON.parse(body);
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result:
                message.method === "initialize"
                  ? {
                      protocolVersion: message.params.protocolVersion,
                      capabilities: { tools: {} },
                      serverInfo: { name: "public-tls-fixture", version: "1" },
                    }
                  : { tools: [{ name: "tls_echo", inputSchema: { type: "object" } }] },
            }),
          );
        });
      }),
    );
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-tls-"));
    const host = wrongHost ? "wrong-host.invalid" : "mcp.fixture.test";
    const port = (service.server.address() as AddressInfo).port;
    const url = `https://${host}:${port}/mcp`;
    const childEnv = { ...process.env };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.NODE_PATH;
    delete childEnv.NODE_TLS_REJECT_UNAUTHORIZED;
    childEnv.NODE_EXTRA_CA_CERTS = path.join(fixtureRoot, "mcp-http-test-ca.pem");
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          process.execPath,
          ["--input-type=module", "--eval", tlsChild, url, directory, String(wrongHost)],
          {
            cwd: process.cwd(),
            env: childEnv,
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 128 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
        );
      });
      expect(JSON.parse(result.stdout)).toMatchObject(
        wrongHost
          ? { connected: false, code: "mcp_http_request_failed" }
          : { connected: true, tools: ["tls_echo"] },
      );
      expect(result.stderr).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
      if (wrongHost) expect(requests).toEqual([]);
      else {
        expect(requests.length).toBeGreaterThan(0);
        expect(
          requests.every((request) => request.host === `${host}:${port}` && request.sni === host),
        ).toBe(true);
      }
      await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  40_000,
);

it("显式 HTTP owner 不读取宿主代理环境变量，允许请求直接抵达固定目标", async () => {
  let trapped = 0;
  const proxy = await listen(
    createServer((_request, response) => {
      trapped += 1;
      response.writeHead(502).end();
    }),
  );
  proxy.server.on("connect", (_request, socket) => {
    trapped += 1;
    socket.destroy();
  });
  const service = await startMcpHttpServer();
  const owner = createMcpHttpFetch({
    url: service.url,
    headers: {},
    allowedAddresses: ["127.0.0.1"],
    runEnvironment: environment(),
  });
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    vi.stubEnv(name, proxy.url);
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  try {
    const response = await owner.fetch(service.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await response.json()).result.tools[0].name).toBe("echo");
    expect(service.records.filter((record) => record.type === "http")).toHaveLength(1);
    expect(trapped).toBe(0);
    expect(proxy.sockets.size).toBe(0);
    await owner.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
  } finally {
    vi.unstubAllEnvs();
    await owner.close();
    await service.close();
    await proxy.close();
  }
});

async function withClient(
  mode: string,
  protocolVersion: "legacy" | "2026-07-28",
  check: (fixture: {
    client: ReturnType<typeof createMcpHttpClient>;
    service: Awaited<ReturnType<typeof startMcpHttpServer>>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-http-integration-"));
  const service = await startMcpHttpServer({ mode, secret });
  const domain = environment();
  const runEnvironment = Object.assign(environment(), { hostNetwork: domain });
  const client = createMcpHttpClient({
    url: service.url,
    headers: { authorization: `Bearer ${secret}` },
    allowedAddresses: ["127.0.0.1"],
    allowedResourceUris: uris,
    sensitiveValues: [secret],
    protocolVersion,
    runEnvironment,
    artifactStore: new ArtifactStore({ cwd: directory }),
  });
  try {
    await check({ client, service });
    expect(
      service.records
        .filter((record) => record.type === "http")
        .every((record) => record.authorizationMatched),
    ).toBe(true);
    await client.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    expect(runEnvironment.isQuiescent()).toBe(true);
    expect(domain.isQuiescent()).toBe(true);
  } finally {
    await client.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function requests(service: Awaited<ReturnType<typeof startMcpHttpServer>>, method: string) {
  return service.records.filter((record) => record.type === "request" && record.method === method);
}

function businessParams(record: { params?: Record<string, unknown> }) {
  // 只剥离官方协议信封，业务参数仍须完整相等，不接受额外宿主字段。
  const { _meta, ...params } = record.params ?? {};
  return params;
}

function environment() {
  return createFakeExecutionEnvironment({
    claimed: { networkEgress: "unrestricted" },
    observed: { networkEgress: "unrestricted" },
  });
}

async function listen(server: Server | HttpsServer) {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    sockets,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const tlsChild = `
import dns from "node:dns/promises";
import { createMcpHttpClient, createFakeExecutionEnvironment } from "coremind-tools/internal";
import { ArtifactStore } from "coremind-tools";
dns.lookup = async () => [{ address: "127.0.0.1", family: 4 }];
const [url, directory, wrongHost] = process.argv.slice(1);
const environment = createFakeExecutionEnvironment({
  claimed: { networkEgress: "unrestricted" },
  observed: { networkEgress: "unrestricted" },
});
const client = createMcpHttpClient({
  url, headers: {}, allowedAddresses: ["127.0.0.1"],
  runEnvironment: environment, artifactStore: new ArtifactStore({ cwd: directory }),
});
try {
  await client.connect();
  const tools = await client.listTools();
  if (wrongHost === "true") throw new Error("错误 hostname 不应通过证书校验");
  process.stdout.write(JSON.stringify({ connected: true, tools: tools.map((tool) => tool.name) }));
} catch (error) {
  if (wrongHost !== "true" || error?.code !== "mcp_http_request_failed") throw error;
  process.stdout.write(JSON.stringify({ connected: false, code: error.code }));
} finally {
  await client.close();
  if (!environment.isQuiescent()) throw new Error("测试 HTTPS 活动未收敛");
}
`;
