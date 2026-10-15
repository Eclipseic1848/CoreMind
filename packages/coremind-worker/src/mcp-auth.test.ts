// 测试只使用固定假值，避免测试环境文件越过 Worker rootDir。
process.env.COREMIND_TEST_API_KEY = "test-only";

import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { ProtocolHost, type WorkerMessage } from "./server.js";

interface AuthenticationFixture {
  clientId: string;
  url: string;
  config: NonNullable<CoreMindConfig["mcp"]>["servers"][string];
  records: Array<{ type: string }>;
  sockets: Set<Socket>;
  completeAuthorization(url: string): Promise<number>;
  close(): Promise<void>;
}
const { startMcpAuthServer } = (await import(
  new URL("../../../test/fixtures/mcp-auth-server.mjs", import.meta.url).href
)) as { startMcpAuthServer(): Promise<AuthenticationFixture> };

it("未协商认证能力时拒绝 RPC，初始化不隐式发现或登录", async () => {
  await fixture(false, async ({ host, service }) => {
    const response = await host.handle(request("login", "no-cap"));
    expect(response).toMatchObject({
      error: { data: { coremindCode: "protocol_capability_missing" } },
    });
    expect(service.records).toEqual([]);
  });
});

it("专用认证通知只在显式 login 发送，成功和 logout 返回封闭安全结果", async () => {
  await fixture(true, async ({ host, service, messages }) => {
    const login = host.handle(request("login", "authorized"));
    await vi.waitFor(() =>
      expect(
        messages.filter((message) => "method" in message && message.method === "mcp_auth_request"),
      ).toHaveLength(1),
    );
    const message = messages.find(
      (message) => "method" in message && message.method === "mcp_auth_request",
    )!;
    if (!("method" in message) || message.method !== "mcp_auth_request")
      throw new Error("缺少专用通知");
    expect(message.params).toMatchObject({
      transactionId: "authorized",
      server: "remote",
      clientId: service.clientId,
      resource: service.url,
    });
    await service.completeAuthorization(message.params.authorizationUrl);
    const response = await login;
    expect(response).toMatchObject({
      result: {
        schemaVersion: 1,
        action: "login",
        status: "authorized",
        transactionId: "authorized",
        server: "remote",
      },
    });
    expect(messages.some((event) => "method" in event && event.method === "event")).toBe(false);
    expect(JSON.stringify(response)).not.toMatch(
      /access_token|refresh_token|code_verifier|authorizationUrl/,
    );
    expect(await host.handle(request("logout"))).toMatchObject({
      result: { schemaVersion: 1, action: "logout", server: "remote", status: "logged_out" },
    });
    expect(service.records.filter((record) => record.type === "token")).toEqual([
      expect.objectContaining({ grant: "authorization_code", valid: true }),
    ]);
  });
});

it("首通知前取消可寻址，login 不持有 Worker transition 长锁", async () => {
  await fixture(true, async ({ host, service, messages }) => {
    const login = host.handle(request("login", "cancel-before"));
    expect(await host.handle(request("cancel", "cancel-before"))).toMatchObject({
      result: { action: "cancel", status: "cancelled" },
    });
    expect(await login).toMatchObject({ error: { data: { coremindCode: "aborted" } } });
    expect(messages).toEqual([]);
    expect(service.records).toEqual([]);
  });
});

it("EOF/shutdown 先取消登录，再 join 临时回调与所有认证请求", async () => {
  await fixture(true, async ({ host, service, messages }) => {
    const login = host.handle(request("login", "shutdown"));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(await host.shutdown()).toEqual({ closed: true, quiescent: true });
    expect(await login).toMatchObject({ error: { data: { coremindCode: "aborted" } } });
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    expect(service.records.some((record) => record.type === "token")).toBe(false);
  });
});

function request(action: "login" | "cancel" | "logout", transactionId = "login") {
  return {
    jsonrpc: "2.0",
    protocolVersion: "2.0",
    id: `${action}-${transactionId}`,
    method: "mcp_auth",
    params: {
      schemaVersion: 1,
      action,
      ...(action !== "logout" ? { transactionId } : {}),
      ...(action !== "cancel" ? { server: "remote" } : {}),
    },
  };
}

async function fixture(
  capability: boolean,
  check: (fixture: {
    host: ProtocolHost;
    service: Awaited<ReturnType<typeof startMcpAuthServer>>;
    messages: WorkerMessage[];
  }) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-worker-auth-"));
  const service = await startMcpAuthServer();
  const messages: WorkerMessage[] = [];
  const host = new ProtocolHost({ send: (message) => messages.push(message) });
  try {
    expect(
      await host.handle({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
          capabilities: capability ? ["mcpAuthentication"] : [],
          configDir: directory,
          config: {
            schemaVersion: 2,
            name: "auth",
            provider: {
              id: "probe",
              baseUrl: "http://127.0.0.1:1/v1",
              model: "probe",
              apiKeyEnv: "COREMIND_TEST_API_KEY",
            },
            agents: { main: {} },
            mcp: { servers: { remote: service.config } },
            permissions: { network: "allow" },
          },
        },
      }),
    ).toMatchObject({
      result: {
        selectedProtocol: "2.0",
        serverCapabilities: capability
          ? expect.arrayContaining(["mcpAuthentication"])
          : expect.not.arrayContaining(["mcpAuthentication"]),
      },
    });
    await check({ host, service, messages });
  } finally {
    await host.shutdown();
    await service.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
