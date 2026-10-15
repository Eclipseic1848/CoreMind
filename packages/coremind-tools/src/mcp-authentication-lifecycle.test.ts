import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpHttpServerConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { bindMcpAuthentication, createMcpAuthenticationEngine } from "./mcp-authentication.js";
import type {
  McpAuthorizationRequest,
  McpTokenRecord,
  McpTokenStore,
} from "./mcp-authentication-types.js";
import { createMcpHttpClient } from "./mcp-http-client.js";

const identity = "a".repeat(64);

it.each(["wrong-resource", "wrong-issuer", "missing-pkce", "cross-token"])(
  "%s 在浏览器交互和 Token 交换之前拒绝",
  async (mode) => {
    const fixture = await setup({ mode });
    const handler = vi.fn();
    try {
      await expect(
        fixture.authentication.login("remote", { onAuthorization: handler }),
      ).rejects.toMatchObject({ code: "mcp_auth_failed" });
      expect(handler).not.toHaveBeenCalled();
      expect(fixture.service.records.some((record) => record.type === "token")).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

it.each(["state", "duplicate-state", "duplicate-code", "issuer", "missing-issuer", "code-error"])(
  "回调 %s 错误不触发 Token 交换，listener 真实关闭",
  async (mode) => {
    const fixture = await setup();
    let callback = "";
    try {
      await expect(
        fixture.authentication.login("remote", {
          onAuthorization: async (request) => {
            const authorization = new URL(request.authorizationUrl);
            callback = authorization.searchParams.get("redirect_uri")!;
            const state = authorization.searchParams.get("state")!;
            const changes: Record<string, string | string[] | null> =
              mode === "state"
                ? { state: "wrong" }
                : mode === "duplicate-state"
                  ? { state: [state, state] }
                  : mode === "duplicate-code"
                    ? { code: ["first", "second"] }
                    : mode === "issuer"
                      ? { iss: `${fixture.service.issuer}/` }
                      : mode === "missing-issuer"
                        ? { iss: null }
                        : { error: "denied", error_description: "must-not-leak-canary" };
            await fixture.service.completeAuthorization(request.authorizationUrl, changes);
          },
        }),
      ).rejects.toMatchObject({ code: "mcp_auth_failed" });
      expect(fixture.service.records.some((record) => record.type === "token")).toBe(false);
      await expect(fetch(callback, { headers: { connection: "close" } })).rejects.toBeDefined();
    } finally {
      await fixture.close();
    }
  },
);

it.each(["extra-scope", "redirect-token"])("%s 明确失败，不发布凭据或跟随重定向", async (mode) => {
  const fixture = await setup({ mode });
  try {
    await expect(fixture.login()).rejects.toMatchObject({ code: "mcp_auth_failed" });
    await expect(fixture.binding().authorize()).rejects.toMatchObject({
      code: "mcp_auth_required",
    });
    expect(fixture.service.records.some((record) => record.path === "/unapproved-token")).toBe(
      false,
    );
  } finally {
    await fixture.close();
  }
});

it("取消真实授权等待后 callback 不再监听，错误不带 handler 内容", async () => {
  const fixture = await setup();
  const controller = new AbortController();
  const entered = deferred<McpAuthorizationRequest>();
  try {
    const login = fixture.authentication.login("remote", {
      signal: controller.signal,
      onAuthorization: (request) => {
        entered.resolve(request);
      },
    });
    const rejected = expect(login).rejects.toMatchObject({ code: "aborted" });
    const request = await entered.promise;
    controller.abort(new Error("private-abort-canary"));
    await rejected;
    const callback = new URL(request.authorizationUrl).searchParams.get("redirect_uri")!;
    await expect(fetch(callback, { headers: { connection: "close" } })).rejects.toBeDefined();
    expect(fixture.service.records.some((record) => record.type === "token")).toBe(false);
  } finally {
    await fixture.close();
  }
});

it("handler 抛异常只返回固定认证错误，不发布原始 cause", async () => {
  const fixture = await setup();
  try {
    const failure = await fixture.authentication
      .login("remote", {
        onAuthorization: () => {
          throw new Error("handler-secret-canary");
        },
      })
      .catch((error) => error);
    expect(failure).toMatchObject({ code: "mcp_auth_failed" });
    expect(String(failure)).not.toContain("handler-secret-canary");
    expect(failure.cause).toBeUndefined();
    expect(fixture.service.records.some((record) => record.type === "token")).toBe(false);
  } finally {
    await fixture.close();
  }
});

it("真实单飞刷新只发送一次，取消等待者不发业务，两个合法调用仍各成功一次", async () => {
  const fixture = await setup({ expiresIn: 0 });
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  try {
    await fixture.login();
    fixture.service.holdRefresh();
    const operations = controllers.map(async (controller, index) => {
      const client = fixture.client(controller.signal);
      await client.connect();
      const tool = (await client.listTools())[0]!;
      return client.callTool(tool, { value: index }, controller.signal);
    });
    const cancelled = expect(operations[0]).rejects.toHaveProperty("code");
    await vi.waitFor(() =>
      expect(
        fixture.service.records.filter(
          (record) => record.type === "token" && record.grant === "refresh_token",
        ),
      ).toHaveLength(1),
    );
    controllers[0]!.abort();
    await cancelled;
    fixture.service.releaseRefresh();
    const results = await Promise.all(operations.slice(1));
    expect(results.every((result) => result.text === "已授权 false 0 null")).toBe(true);
    expect(
      fixture.service.records.filter(
        (record) => record.type === "token" && record.grant === "refresh_token",
      ),
    ).toHaveLength(1);
    expect(
      fixture.service.records.filter(
        (record) => record.type === "rpc" && record.method === "tools/call",
      ),
    ).toHaveLength(2);
  } finally {
    for (const controller of controllers) controller.abort();
    fixture.service.releaseRefresh();
    await fixture.close();
  }
});

it("最后一个 refresh 等待者取消后，真实 Token 请求不继续占用 socket", async () => {
  const fixture = await setup({ expiresIn: 0 });
  const controllers = [new AbortController(), new AbortController()];
  try {
    await fixture.login();
    fixture.service.holdRefresh();
    const binding = fixture.binding();
    const operations = controllers.map((controller) => binding.authorize(controller.signal));
    const outcomes = Promise.allSettled(operations);
    await vi.waitFor(() =>
      expect(
        fixture.service.records.filter(
          (record) => record.type === "token" && record.grant === "refresh_token",
        ),
      ).toHaveLength(1),
    );
    for (const controller of controllers) controller.abort();
    const results = await outcomes;
    expect(
      results.every((result) => result.status === "rejected" && result.reason.code === "aborted"),
    ).toBe(true);
    await vi.waitFor(() => expect(fixture.service.sockets.size).toBe(0));
    expect(fixture.service.records.some((record) => record.type === "rpc")).toBe(false);
  } finally {
    for (const controller of controllers) controller.abort();
    fixture.service.releaseRefresh();
    await fixture.close();
  }
});

it("刷新失败不回退旧 token 或开始业务请求", async () => {
  const fixture = await setup({ expiresIn: 0 });
  try {
    await fixture.login();
    fixture.service.setMode("reject-refresh");
    await expect(fixture.binding().authorize()).rejects.toMatchObject({ code: "mcp_auth_failed" });
    await expect(fixture.binding().authorize()).rejects.toMatchObject({
      code: "mcp_auth_required",
    });
    expect(
      fixture.service.records.filter(
        (record) => record.type === "token" && record.grant === "refresh_token",
      ),
    ).toHaveLength(1);
    expect(fixture.service.records.some((record) => record.type === "rpc")).toBe(false);
  } finally {
    await fixture.close();
  }
});

it.each(["load", "save", "delete"] as const)(
  "安全 store.%s 失败关闭，旧凭据不作为静默回退",
  async (operation) => {
    const records = new Map<string, McpTokenRecord>();
    const store: McpTokenStore = {
      load: vi.fn(async (key) => {
        if (operation === "load") throw new Error("store-secret");
        return records.get(key);
      }),
      save: vi.fn(async (key, record) => {
        if (operation === "save") throw new Error("store-secret");
        records.set(key, record);
      }),
      delete: vi.fn(async (key) => {
        if (operation === "delete") throw new Error("store-secret");
        records.delete(key);
      }),
    };
    const fixture = await setup({}, store);
    try {
      if (operation === "load")
        await expect(fixture.binding().authorize()).rejects.toMatchObject({
          code: "mcp_auth_store_failed",
        });
      else if (operation === "save")
        await expect(fixture.login()).rejects.toMatchObject({ code: "mcp_auth_store_failed" });
      else {
        await fixture.login();
        const binding = fixture.binding();
        await expect(fixture.authentication.logout("remote")).rejects.toMatchObject({
          code: "mcp_auth_store_failed",
        });
        expect(() => binding.assertActive()).toThrow();
      }
      await expect(fixture.binding().authorize()).rejects.toMatchObject({
        code: "mcp_auth_required",
      });
      expect(fixture.service.records.some((record) => record.type === "rpc")).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

it("logout 先撤销 epoch，已开始的 save 之后才 delete，迟到保存不重新授权", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const stored = new Map<string, McpTokenRecord>();
  const order: string[] = [];
  const store: McpTokenStore = {
    load: async (key) => stored.get(key),
    save: async (key, record) => {
      order.push("save-start");
      entered.resolve();
      await release.promise;
      stored.set(key, record);
      order.push("save-end");
    },
    delete: async (key) => {
      order.push("delete");
      stored.delete(key);
    },
  };
  const fixture = await setup({}, store);
  try {
    const login = fixture.login();
    const rejected = expect(login).rejects.toHaveProperty("code");
    await entered.promise;
    const old = fixture.binding();
    const logout = fixture.authentication.logout("remote");
    expect(() => old.assertActive()).toThrow();
    await rejected;
    expect(order).toEqual(["save-start"]);
    release.resolve();
    await logout;
    expect(order).toEqual(["save-start", "save-end", "delete"]);
    expect(stored.size).toBe(0);
    await expect(fixture.binding().authorize()).rejects.toMatchObject({
      code: "mcp_auth_required",
    });
  } finally {
    release.resolve();
    await fixture.close();
  }
});

it("同名服务的伪造 session 和不同 identity 在 store/HTTP 之前拒绝", async () => {
  const store: McpTokenStore = {
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
  const fixture = await setup({}, store);
  try {
    expect(() =>
      bindMcpAuthentication(
        {
          login: fixture.authentication.login,
          logout: fixture.authentication.logout,
          close: fixture.authentication.close,
        },
        "remote",
        identity,
      ),
    ).toThrow();
    expect(() => bindMcpAuthentication(fixture.authentication, "remote", "b".repeat(64))).toThrow();
    expect(store.load).not.toHaveBeenCalled();
    expect(fixture.service.records).toEqual([]);
  } finally {
    await fixture.close();
  }
});

it.each([
  { absoluteOrigin: "http://wrong.invalid" },
  { host: "wrong.invalid" },
  { method: "POST" },
  { path: "/wrong" },
])(
  "真实 callback 的 Host/absolute-form origin/method/path 都须匹配：%j",
  async (callbackOptions) => {
    const fixture = await setup();
    try {
      await expect(
        fixture.authentication.login("remote", {
          onAuthorization: async (request) => {
            await fixture.service.completeAuthorization(
              request.authorizationUrl,
              {},
              callbackOptions,
            );
          },
        }),
      ).rejects.toMatchObject({ code: "mcp_auth_failed" });
      expect(fixture.service.records.some((record) => record.type === "token")).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

it("logout 返回前旧 login 已结算，callback 不再监听", async () => {
  const fixture = await setup();
  const entered = deferred<McpAuthorizationRequest>();
  let settled = false;
  try {
    const login = fixture.authentication.login("remote", {
      onAuthorization: (request) => {
        entered.resolve(request);
      },
    });
    void login
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    const rejected = expect(login).rejects.toHaveProperty("code");
    const request = await entered.promise;
    await fixture.authentication.logout("remote");
    expect(settled).toBe(true);
    await rejected;
    await expect(
      fetch(new URL(request.authorizationUrl).searchParams.get("redirect_uri")!, {
        headers: { connection: "close" },
      }),
    ).rejects.toBeDefined();
    expect(fixture.service.records.some((record) => record.type === "token")).toBe(false);
  } finally {
    await fixture.close();
  }
});

it("同一 Run signal 的并发请求不逐个累积取消监听，取消后全收敛", async () => {
  const fixture = await setup();
  const controller = new AbortController();
  try {
    await fixture.login();
    const client = fixture.client(controller.signal);
    await client.connect();
    const tool = (await client.listTools())[0]!;
    const baseline = getEventListeners(controller.signal, "abort").length;
    fixture.service.setMode("hold-access");
    const calls = Array.from({ length: 24 }, (_, index) => client.callTool(tool, { value: index }));
    const outcomes = Promise.allSettled(calls);
    await vi.waitFor(() =>
      expect(
        fixture.service.records.some(
          (record) => record.type === "rpc" && record.method === "tools/call",
        ),
      ).toBe(true),
    );
    expect(getEventListeners(controller.signal, "abort").length).toBeLessThanOrEqual(baseline + 1);
    controller.abort();
    expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
    await client.close();
  } finally {
    controller.abort();
    await fixture.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function setup(
  options: Parameters<typeof startMcpAuthServer>[0] = {},
  tokenStore?: McpTokenStore,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-auth-lifecycle-"));
  const service = await startMcpAuthServer(options);
  const authentication = createMcpAuthenticationEngine({
    servers: [
      { server: "remote", config: service.config as McpHttpServerConfig, serverIdentity: identity },
    ],
    network: "allow",
    ...(tokenStore ? { tokenStore, namespace: "isolated-owner" } : {}),
  });
  const environment = createFakeExecutionEnvironment({
    claimed: { networkEgress: "unrestricted" },
    observed: { networkEgress: "unrestricted" },
  });
  const clients: ReturnType<typeof createMcpHttpClient>[] = [];
  const binding = () => bindMcpAuthentication(authentication, "remote", identity, environment);
  return {
    service,
    authentication,
    binding,
    login: () =>
      authentication.login("remote", {
        onAuthorization: async (request) => {
          expect(await service.completeAuthorization(request.authorizationUrl)).toBe(200);
        },
      }),
    client(signal?: AbortSignal) {
      const client = createMcpHttpClient({
        url: service.url,
        headers: {},
        allowedAddresses: ["127.0.0.1"],
        runEnvironment: environment,
        signal,
        artifactStore: new ArtifactStore({ cwd: directory }),
        authentication: binding(),
      });
      clients.push(client);
      return client;
    },
    async close() {
      try {
        await Promise.all(clients.map((client) => client.close()));
        await authentication.close();
        await vi.waitFor(() => expect(service.sockets.size).toBe(0));
        expect(environment.isQuiescent()).toBe(true);
      } finally {
        await service.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
