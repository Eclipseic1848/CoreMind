import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
  ProtocolV2McpAuthRequestNotificationSchema,
  ProtocolV2McpAuthResultSchema,
  parseProtocolV2McpAuthRequestNotification,
  parseProtocolV2Request,
} from "./index.js";

describe("认证只使用封闭的临时 v2 通道", () => {
  it.each([
    { schemaVersion: 1, action: "login", transactionId: "login-1", server: "remote" },
    { schemaVersion: 1, action: "cancel", transactionId: "login-1" },
    { schemaVersion: 1, action: "logout", server: "remote" },
  ])("解析认证动作 $action，拒绝凭据附带字段", (params) => {
    const request = { jsonrpc: "2.0", protocolVersion: "2.0", id: 1, method: "mcp_auth", params };
    expect(parseProtocolV2Request(request)).toEqual(request);
    for (const key of ["token", "code", "codeVerifier", "authorizationUrl", "unexpected"]) {
      expect(() =>
        parseProtocolV2Request({ ...request, params: { ...params, [key]: "private" } }),
      ).toThrow();
    }
  });

  it("专用请求包含唯一安全身份与公开导航 URL，不接受秘密字段", () => {
    const params = {
      schemaVersion: 1,
      transactionId: "login-1",
      server: "remote",
      serverIdentity: "a".repeat(64),
      authorizationUrl: "https://issuer.example/authorize?state=public&code_challenge=public",
      expiresAt: "2030-01-01T00:00:00.000Z",
      issuer: "https://issuer.example/",
      clientId: "native-client",
      resource: "https://mcp.example/rpc",
      scopes: ["read"],
    };
    const message = { jsonrpc: "2.0", protocolVersion: "2.0", method: "mcp_auth_request", params };
    expect(Value.Check(ProtocolV2McpAuthRequestNotificationSchema, message)).toBe(true);
    for (const key of ["code", "access_token", "refresh_token", "code_verifier", "client_secret"])
      expect(() =>
        parseProtocolV2McpAuthRequestNotification({
          ...message,
          params: {
            ...params,
            authorizationUrl: `https://issuer.example/authorize?${key}=private`,
          },
        }),
      ).toThrow("不能携带凭据");
    for (const key of ["token", "refreshToken", "code", "state", "verifier", "extra"]) {
      expect(
        Value.Check(ProtocolV2McpAuthRequestNotificationSchema, {
          ...message,
          params: { ...params, [key]: "private" },
        }),
      ).toBe(false);
    }
  });

  it("login 结果仅 authorized，失败必须走 typed error", () => {
    const result = {
      schemaVersion: 1,
      action: "login",
      status: "authorized",
      transactionId: "login-1",
      server: "remote",
      serverIdentity: "a".repeat(64),
    };
    expect(Value.Check(ProtocolV2McpAuthResultSchema, result)).toBe(true);
    for (const status of ["cancelled", "failed", "expired"]) {
      expect(Value.Check(ProtocolV2McpAuthResultSchema, { ...result, status })).toBe(false);
    }
    expect(Value.Check(ProtocolV2McpAuthResultSchema, { ...result, accessToken: "private" })).toBe(
      false,
    );
  });
});
