import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpHttpServerConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { bindMcpAuthentication, createMcpAuthenticationEngine } from "./mcp-authentication.js";
import type {
  McpAuthentication,
  McpTokenRecord,
  McpTokenStore,
} from "./mcp-authentication-types.js";
import { createMcpHttpClient } from "./mcp-http-client.js";

const identity = "a".repeat(64);

it("显式安全 store 跨宿主恢复，同 store 不同 namespace 和默认内存宿主不复用", async () => {
  const fixture = await setup();
  try {
    const first = fixture.session("stable-owner");
    await fixture.login(first);
    await first.close();
    const requests = fixture.service.records.length;
    const next = fixture.session("stable-owner");
    expect(await bindMcpAuthentication(next, "remote", identity).authorize()).toEqual(
      expect.any(String),
    );
    await expect(
      bindMcpAuthentication(fixture.session("another-owner"), "remote", identity).authorize(),
    ).rejects.toMatchObject({ code: "mcp_auth_required" });
    await expect(
      bindMcpAuthentication(fixture.session(), "remote", identity).authorize(),
    ).rejects.toMatchObject({ code: "mcp_auth_required" });
    expect(fixture.service.records).toHaveLength(requests);
  } finally {
    await fixture.close();
  }
});

it.each([
  { namespace: "another-owner" },
  { serverIdentity: "b".repeat(64) },
  { resource: "https://other.invalid/mcp" },
  { issuer: "https://other.invalid" },
  { clientId: "another-client" },
  { scopes: ["unexpected:write"] },
  { tokenType: "Other" },
])("store 记录绑定不匹配在任何网络之前拒绝：%j", async (changes) => {
  const fixture = await setup();
  try {
    const first = fixture.session("stable-owner");
    await fixture.login(first);
    await first.close();
    const requests = fixture.service.records.length;
    const persisted = [...fixture.stored.values()][0]!;
    const store: McpTokenStore = {
      load: async () => ({ ...persisted, ...changes }) as McpTokenRecord,
      save: async () => {},
      delete: async () => {},
    };
    const next = fixture.session("stable-owner", store);
    await expect(bindMcpAuthentication(next, "remote", identity).authorize()).rejects.toMatchObject(
      { code: "mcp_auth_store_failed" },
    );
    await expect(bindMcpAuthentication(next, "remote", identity).authorize()).rejects.toMatchObject(
      { code: "mcp_auth_required" },
    );
    expect(fixture.service.records).toHaveLength(requests);
  } finally {
    await fixture.close();
  }
});

it.each(["header-access", "split-access", "large-secret", "echo-refresh"])(
  "刷新后 %s 的动态凭据在公开结果和 Artifact 写入前阻断",
  async (mode) => {
    const fixture = await setup({ expiresIn: 0 });
    try {
      const session = fixture.session("stable-owner");
      await fixture.login(session);
      const client = fixture.client(session);
      await client.connect();
      const tool = (await client.listTools())[0]!;
      fixture.service.setMode(mode);
      await expect(client.callTool(tool, { value: false })).rejects.toMatchObject({
        code: "mcp_secret_blocked",
      });
      expect(fixture.imported).not.toHaveBeenCalled();
      expect(
        fixture.service.records.filter(
          (record) => record.type === "token" && record.grant === "refresh_token",
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  },
);

it("刷新后错误响应中的远端正文不进入公开错误 cause", async () => {
  const fixture = await setup({ expiresIn: 0 });
  try {
    const session = fixture.session("stable-owner");
    await fixture.login(session);
    const client = fixture.client(session);
    await client.connect();
    const tool = (await client.listTools())[0]!;
    fixture.service.setMode("error-access");
    const failure = await client.callTool(tool, { value: false }).catch((error) => error);
    expect(failure).toMatchObject({ code: "mcp_http_status_error" });
    for (const record of fixture.stored.values()) {
      expect(String(failure)).not.toContain(record.accessToken);
      expect(JSON.stringify(failure)).not.toContain(record.accessToken);
    }
    expect(failure.cause).toBeUndefined();
    expect(fixture.imported).not.toHaveBeenCalled();
  } finally {
    await fixture.close();
  }
});

it("已发送业务 POST 收到 401 只返回需授权，不刷新或重发该业务", async () => {
  const fixture = await setup();
  try {
    const session = fixture.session("stable-owner");
    await fixture.login(session);
    const client = fixture.client(session);
    await client.connect();
    const tool = (await client.listTools())[0]!;
    fixture.service.setMode("reject-call");
    await expect(client.callTool(tool, { value: "write-once" })).rejects.toMatchObject({
      code: "mcp_auth_required",
    });
    expect(
      fixture.service.records.filter(
        (record) => record.type === "rpc" && record.method === "tools/call",
      ),
    ).toHaveLength(1);
    expect(fixture.service.records.filter((record) => record.type === "token")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

it("在飞旧 access token 在另一请求刷新之后仍被保护", async () => {
  const fixture = await setup({ expiresIn: 1 });
  const initialTime = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
  try {
    const session = fixture.session("stable-owner");
    await fixture.login(session);
    const client = fixture.client(session);
    await client.connect();
    const tool = (await client.listTools())[0]!;
    fixture.service.setMode("hold-access");
    const old = client.callTool(tool, { value: "old" });
    const blocked = expect(old).rejects.toMatchObject({ code: "mcp_secret_blocked" });
    await vi.waitFor(() =>
      expect(
        fixture.service.records.filter(
          (record) => record.type === "rpc" && record.method === "tools/call",
        ),
      ).toHaveLength(1),
    );
    fixture.service.setMode("normal");
    clock.mockReturnValue(initialTime + 2_000);
    expect((await client.callTool(tool, { value: "new" })).text).toBe("已授权 false 0 null");
    expect(
      fixture.service.records.filter(
        (record) => record.type === "token" && record.grant === "refresh_token",
      ),
    ).toHaveLength(1);
    fixture.service.releaseCalls();
    await blocked;
    expect(fixture.imported).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
    fixture.service.releaseCalls();
    await fixture.close();
  }
});

it("合法大结果仍正常保存 Artifact，刷新后的凭据不混入完整文件", async () => {
  const fixture = await setup({ expiresIn: 0 });
  try {
    const session = fixture.session("stable-owner");
    await fixture.login(session);
    const client = fixture.client(session);
    await client.connect();
    const tool = (await client.listTools())[0]!;
    fixture.service.setMode("large-safe");
    const result = await client.callTool(tool, { value: false });
    const details = result.details as { artifact: { status: string; relativePath: string } };
    expect(details.artifact.status).toBe("stored");
    expect(fixture.imported).toHaveBeenCalledOnce();
    const file = await readFile(
      path.join(fixture.directory, details.artifact.relativePath),
      "utf8",
    );
    expect(file).toContain("安全正文".repeat(100));
    for (const record of fixture.stored.values()) {
      expect(file).not.toContain(record.accessToken);
      expect(file).not.toContain(record.refreshToken!);
    }
  } finally {
    await fixture.close();
  }
});

it("close 对不合作的实际 store 操作有界报失败，不能把超时清理当成功", async () => {
  const fixture = await setup();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const store: McpTokenStore = {
    load: async () => undefined,
    save: async () => {
      entered();
      await gate;
    },
    delete: async () => {},
  };
  let session: McpAuthentication | undefined;
  try {
    session = fixture.session("stable-owner", store);
    const login = fixture.login(session);
    const cancelled = expect(login).rejects.toMatchObject({ code: "aborted" });
    await started;
    const binding = bindMcpAuthentication(session, "remote", identity);
    await expect(session.close()).rejects.toMatchObject({ code: "mcp_auth_store_failed" });
    await cancelled;
    expect(() => binding.assertActive()).toThrow();
    expect(fixture.service.records.some((record) => record.type === "rpc")).toBe(false);
  } finally {
    release();
    await session?.close().catch(() => {});
    await fixture.close(true);
  }
}, 15_000);

async function setup(options: Parameters<typeof startMcpAuthServer>[0] = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-auth-security-"));
  const service = await startMcpAuthServer(options);
  const stored = new Map<string, McpTokenRecord>();
  const tokenStore: McpTokenStore = {
    load: async (key) => stored.get(key),
    save: async (key, record) => {
      stored.set(key, structuredClone(record));
    },
    delete: async (key) => {
      stored.delete(key);
    },
  };
  const sessions: McpAuthentication[] = [];
  const clients: ReturnType<typeof createMcpHttpClient>[] = [];
  const artifactStore = new ArtifactStore({ cwd: directory });
  const imported = vi.spyOn(artifactStore, "importFile");
  const environment = createFakeExecutionEnvironment({
    claimed: { networkEgress: "unrestricted" },
    observed: { networkEgress: "unrestricted" },
  });
  return {
    service,
    stored,
    imported,
    directory,
    session(namespace?: string, store: McpTokenStore = tokenStore) {
      const session = createMcpAuthenticationEngine({
        servers: [
          {
            server: "remote",
            config: service.config as McpHttpServerConfig,
            serverIdentity: identity,
          },
        ],
        network: "allow",
        ...(namespace === undefined ? {} : { tokenStore: store, namespace }),
      });
      sessions.push(session);
      return session;
    },
    login: (session: McpAuthentication) =>
      session.login("remote", {
        onAuthorization: async (request) => {
          expect(await service.completeAuthorization(request.authorizationUrl)).toBe(200);
        },
      }),
    client(session: McpAuthentication) {
      const client = createMcpHttpClient({
        url: service.url,
        headers: {},
        allowedAddresses: ["127.0.0.1"],
        runEnvironment: environment,
        artifactStore,
        authentication: bindMcpAuthentication(session, "remote", identity),
      });
      clients.push(client);
      return client;
    },
    async close(expectedFailure = false) {
      try {
        await Promise.all(clients.map((client) => client.close()));
        const results = await Promise.allSettled(sessions.map((session) => session.close()));
        if (!expectedFailure)
          expect(results.every((result) => result.status === "fulfilled")).toBe(true);
        await vi.waitFor(() => expect(service.sockets.size).toBe(0));
        expect(environment.isQuiescent()).toBe(true);
      } finally {
        await service.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
