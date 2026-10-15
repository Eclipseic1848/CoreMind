import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpHttpServerConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { bindMcpAuthentication, createMcpAuthenticationEngine } from "./mcp-authentication.js";
import type { McpAuthentication, McpTokenStore } from "./mcp-authentication-types.js";
import { createMcpHttpClient } from "./mcp-http-client.js";

const identity = "a".repeat(64);

it("真实受保护 MCP 缺少或错误 Bearer 都返回 401，不执行工具", async () => {
  const service = await startMcpAuthServer();
  try {
    for (const headers of [{}, { Authorization: "Bearer wrong" }]) {
      const response = await fetch(service.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      expect(response.status).toBe(401);
      await response.arrayBuffer();
    }
    expect(service.records.filter((record) => record.type === "rpc")).toEqual([]);
  } finally {
    await service.close();
  }
});

it("没有 handler 的显式登录在发现、监听与 store 之前明确 required", async () => {
  const service = await startMcpAuthServer();
  const store: McpTokenStore = {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const authentication = session(service, { tokenStore: store, namespace: "headless" });
  try {
    await expect(authentication.login("remote")).rejects.toMatchObject({
      code: "mcp_auth_required",
    });
    expect(service.records).toEqual([]);
    expect(store.load).not.toHaveBeenCalled();
  } finally {
    await authentication.close();
    await service.close();
  }
});

it("network deny 在任何认证网络和 handler 前失败关闭", async () => {
  const service = await startMcpAuthServer();
  const authentication = session(service, { network: "deny" });
  const handler = vi.fn();
  try {
    await expect(
      authentication.login("remote", { onAuthorization: handler }),
    ).rejects.toMatchObject({ code: "mcp_auth_failed" });
    expect(service.records).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  } finally {
    await authentication.close();
    await service.close();
  }
});

it("显式授权经真正 AS、PKCE/code 回调后才能连接受保护 MCP", async () => {
  await withAuthorized({}, async ({ client, service }) => {
    const tool = (await client.listTools())[0]!;
    const result = await client.callTool(tool, { value: [false, 0, null] });
    expect(result.text).toBe("已授权 false 0 null");
    expect(service.records.filter((record) => record.type === "authorization")).toEqual([
      { type: "authorization", valid: true },
    ]);
    expect(service.records.filter((record) => record.type === "token")).toEqual([
      { type: "token", grant: "authorization_code", valid: true },
    ]);
    expect(
      service.records.filter((record) => record.type === "rpc" && record.method === "tools/call"),
    ).toHaveLength(1);
  });
});

it("合法刷新返回相同 refresh token 仍成功，不能套用 MCP 正文泄漏规则", async () => {
  await withAuthorized({ expiresIn: 0 }, async ({ client, service }) => {
    expect((await client.listTools())[0]!.name).toBe("echo");
    expect(
      service.records.filter(
        (record) => record.type === "token" && record.grant === "refresh_token",
      ),
    ).toEqual([{ type: "token", grant: "refresh_token", valid: true }]);
    expect(
      service.records
        .filter((record) => record.type === "mcp")
        .every((record) => record.authorized),
    ).toBe(true);
  });
});

it("同一个 refresh token 出现在 MCP 正文仍必须在公开结果之前拒绝", async () => {
  await withAuthorized({ mode: "echo-refresh" }, async ({ client }) => {
    const tool = (await client.listTools())[0]!;
    await expect(client.callTool(tool, { value: false })).rejects.toMatchObject({
      code: "mcp_secret_blocked",
    });
  });
});

function session(
  service: Awaited<ReturnType<typeof startMcpAuthServer>>,
  overrides: Partial<Parameters<typeof createMcpAuthenticationEngine>[0]> = {},
): McpAuthentication {
  return createMcpAuthenticationEngine({
    servers: [
      { server: "remote", config: service.config as McpHttpServerConfig, serverIdentity: identity },
    ],
    network: "allow",
    ...overrides,
  });
}

async function withAuthorized(
  options: Parameters<typeof startMcpAuthServer>[0],
  check: (fixture: {
    client: ReturnType<typeof createMcpHttpClient>;
    service: Awaited<ReturnType<typeof startMcpAuthServer>>;
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-auth-test-"));
  const service = await startMcpAuthServer(options);
  const authentication = session(service);
  let client: ReturnType<typeof createMcpHttpClient> | undefined;
  try {
    const result = await authentication.login("remote", {
      onAuthorization: async (request) => {
        expect(request).toMatchObject({
          server: "remote",
          serverIdentity: identity,
          resource: service.url,
          issuer: service.issuer,
        });
        expect(new URL(request.authorizationUrl).searchParams.get("code_challenge_method")).toBe(
          "S256",
        );
        expect(await service.completeAuthorization(request.authorizationUrl)).toBe(200);
      },
    });
    expect(result).toMatchObject({
      server: "remote",
      serverIdentity: identity,
      status: "authorized",
    });
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    client = createMcpHttpClient({
      url: service.url,
      headers: {},
      allowedAddresses: ["127.0.0.1"],
      runEnvironment: environment,
      artifactStore: new ArtifactStore({ cwd: directory }),
      authentication: bindMcpAuthentication(authentication, "remote", identity, environment),
    });
    await client.connect();
    await check({ client, service });
    await client.close();
    await authentication.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    expect(environment.isQuiescent()).toBe(true);
  } finally {
    await client?.close();
    await authentication.close();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}
