import type { McpHttpServerConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { createMcpAuthenticationEngine } from "./mcp-authentication.js";
import type { McpAuthorizationRequest } from "./mcp-authentication-types.js";
import { McpStdioError } from "./mcp-stdio-transport.js";

it("真实授权 handler 抛同类错误仍净化消息、cause 与对象身份", async () => {
  const service = await startMcpAuthServer();
  const authentication = session(service);
  const unsafe = Object.assign(new McpStdioError("mcp_auth_failed", "handler-secret-canary"), {
    cause: new Error("handler-cause-canary"),
  });
  let callback = "";
  try {
    const failure = await authentication
      .login("remote", {
        onAuthorization: (request) => {
          callback = new URL(request.authorizationUrl).searchParams.get("redirect_uri")!;
          throw unsafe;
        },
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "mcp_auth_failed" });
    expect(failure).not.toBe(unsafe);
    expect(String(failure)).not.toContain("canary");
    expect(JSON.stringify(failure)).not.toContain("canary");
    expect((failure as Error).cause).toBeUndefined();
    expect(callback).not.toBe("");
    await expect(fetch(callback, { headers: { connection: "close" } })).rejects.toBeDefined();
    expect(service.records.some((record) => record.type === "token")).toBe(false);
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
  } finally {
    await authentication.close();
    await service.close();
  }
});

it("真实授权取消的同类 signal.reason 不原样进入公开拒绝", async () => {
  const service = await startMcpAuthServer();
  const authentication = session(service);
  const controller = new AbortController();
  const entered = deferred<McpAuthorizationRequest>();
  const unsafe = Object.assign(new McpStdioError("aborted", "abort-secret-canary"), {
    cause: new Error("abort-cause-canary"),
  });
  let login: Promise<unknown> | undefined;
  try {
    login = authentication.login("remote", {
      signal: controller.signal,
      onAuthorization: (request) => {
        entered.resolve(request);
      },
    });
    const outcome = login.catch((error: unknown) => error);
    const request = await entered.promise;
    controller.abort(unsafe);
    const failure = await outcome;
    expect(failure).toMatchObject({ code: "aborted" });
    expect(failure).not.toBe(unsafe);
    expect(String(failure)).not.toContain("canary");
    expect(JSON.stringify(failure)).not.toContain("canary");
    expect((failure as Error).cause).toBeUndefined();
    const callback = new URL(request.authorizationUrl).searchParams.get("redirect_uri")!;
    await expect(fetch(callback, { headers: { connection: "close" } })).rejects.toBeDefined();
    expect(service.records.some((record) => record.type === "token")).toBe(false);
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
  } finally {
    controller.abort();
    await login?.catch(() => {});
    await authentication.close();
    await service.close();
  }
});

it("触发生产 180 秒期限 timer 后真实 callback 关闭，迟到 AS 回调不换 Token", async () => {
  const service = await startMcpAuthServer();
  const authentication = session(service);
  const entered = deferred<McpAuthorizationRequest>();
  const schedule = globalThis.setTimeout;
  let expire: (() => void) | undefined;
  // 只截获并触发生产期限回调；网络与其他计时器仍真实运行，不冒充等待了 180 秒墙钟。
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation((callback, delay, ...args) => {
      if (delay === 180_000) expire = () => callback(...args);
      return schedule(callback, delay, ...args);
    });
  let login: Promise<unknown> | undefined;
  try {
    login = authentication.login("remote", {
      onAuthorization: (request) => {
        entered.resolve(request);
      },
    });
    const rejected = expect(login).rejects.toMatchObject({ code: "run_timeout" });
    const request = await entered.promise;
    expect(expire).toBeTypeOf("function");
    expire!();
    await rejected;
    // AS 仍发出真实、合法的一次性 code；本机 callback 已停止，不能接受迟到授权。
    await expect(service.completeAuthorization(request.authorizationUrl)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
    expect(service.records.filter((record) => record.type === "authorization")).toEqual([
      { type: "authorization", valid: true },
    ]);
    expect(service.records.some((record) => record.type === "token")).toBe(false);
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    await authentication.close();
  } finally {
    await authentication.close();
    await login?.catch(() => {});
    timer.mockRestore();
    await service.close();
  }
});

function session(service: Awaited<ReturnType<typeof startMcpAuthServer>>) {
  return createMcpAuthenticationEngine({
    servers: [
      {
        server: "remote",
        config: service.config as McpHttpServerConfig,
        serverIdentity: "a".repeat(64),
      },
    ],
    network: "allow",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
