import type { McpHttpServerConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpAuthServer } from "../../../test/fixtures/mcp-auth-server.mjs";
import { createMcpAuthenticationEngine } from "./mcp-authentication.js";
import type { McpAuthorizationRequest } from "./mcp-authentication-types.js";

const identity = "a".repeat(64);

it("真实 WebCrypto PKCE 等待期间取消，释放后不再调用授权 handler", async () => {
  const service = await startMcpAuthServer();
  const authentication = session(service);
  const controller = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  const subtle = globalThis.crypto.subtle;
  const original = subtle.digest.bind(subtle);
  const digest = vi.spyOn(subtle, "digest").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const handler = vi.fn();
  let login: Promise<unknown> | undefined;
  try {
    login = authentication.login("remote", { signal: controller.signal, onAuthorization: handler });
    const cancelled = expect(login).rejects.toMatchObject({ code: "aborted" });
    await entered.promise;
    controller.abort();
    release.resolve();
    await cancelled;
    expect(handler).not.toHaveBeenCalled();
    expect(
      service.records.some((record) => record.type === "authorization" || record.type === "token"),
    ).toBe(false);
    await authentication.close();
    await vi.waitFor(() => expect(service.sockets.size).toBe(0));
  } finally {
    controller.abort();
    release.resolve();
    await login?.catch(() => {});
    digest.mockRestore();
    await authentication.close();
    await service.close();
  }
});

it("授权通知 expiresAt 沿用发现前已开始的整体期限", async () => {
  const service = await startMcpAuthServer();
  const authentication = session(service);
  const controller = new AbortController();
  const request = deferred<McpAuthorizationRequest>();
  const initialTime = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
  const originalPush = service.records.push.bind(service.records);
  const records = vi.spyOn(service.records, "push").mockImplementation((...items) => {
    const length = originalPush(...items);
    if (
      items.some(
        (record) =>
          record.type === "http" && record.path === "/.well-known/oauth-protected-resource/mcp",
      )
    ) {
      clock.mockReturnValue(initialTime + 30_000);
    }
    return length;
  });
  let login: Promise<unknown> | undefined;
  try {
    login = authentication.login("remote", {
      signal: controller.signal,
      onAuthorization: (value) => {
        request.resolve(value);
      },
    });
    const cancelled = expect(login).rejects.toMatchObject({ code: "aborted" });
    const authorization = await request.promise;
    try {
      expect(Date.parse(authorization.expiresAt)).toBe(initialTime + 180_000);
    } finally {
      controller.abort();
      await cancelled;
    }
    const callback = new URL(authorization.authorizationUrl).searchParams.get("redirect_uri")!;
    await expect(fetch(callback, { headers: { connection: "close" } })).rejects.toBeDefined();
    expect(service.records.some((record) => record.type === "token")).toBe(false);
  } finally {
    controller.abort();
    await login?.catch(() => {});
    records.mockRestore();
    clock.mockRestore();
    await authentication.close();
    await service.close();
  }
});

function session(service: Awaited<ReturnType<typeof startMcpAuthServer>>) {
  return createMcpAuthenticationEngine({
    servers: [
      { server: "remote", config: service.config as McpHttpServerConfig, serverIdentity: identity },
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
