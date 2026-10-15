import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "./validate.js";

const oauth = {
  issuer: "https://auth.example.test",
  clientId: "coremind-host",
  scopes: ["resource:read"],
};

function project(patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    name: "显式认证配置",
    mcp: {
      servers: {
        remote: {
          transport: "streamable-http",
          url: "https://mcp.example.test/mcp",
          oauth,
          ...patch,
        },
      },
    },
    agents: { main: { mcpResources: { remote: ["note://authorized"] } } },
  };
}

describe("HTTP MCP 的显式 OAuth 配置", () => {
  it("保留固定 issuer、公开 client 和显式 scope，不生成凭据", () => {
    expect(validateConfig(project())).toMatchObject({
      mcp: { servers: { remote: { oauth, protocolVersion: "legacy" } } },
    });
  });

  it("本地假授权服务独立声明精确 loopback 地址", () => {
    const selected = {
      ...oauth,
      issuer: "http://127.0.0.1:43210",
      allowedAddresses: ["127.0.0.1"],
    };
    expect(validateConfig(project({ oauth: selected }))).toMatchObject({
      mcp: { servers: { remote: { oauth: selected } } },
    });
  });

  it.each([
    { issuer: "http://localhost:43210", allowedAddresses: ["127.0.0.1"] },
    { issuer: "http://127.1:43210", allowedAddresses: ["127.0.0.1"] },
    { issuer: "http://127.0.0.1:43210" },
    { issuer: "https://user:password@auth.example.test" },
    { issuer: "https://auth.example.test?token=x" },
    { issuer: "https://auth.example.test/#" },
    { issuer: "https://auth.example.test\\ignored" },
    { clientId: "" },
    { clientId: "client\nother" },
    { scopes: [""] },
    { scopes: ["two scopes"] },
    { scopes: ['quote"scope'] },
    { scopes: ["read", "read"] },
    { allowedAddresses: [] },
    { allowedAddresses: ["127.0.0.1/8"] },
    { accessToken: "不允许配置持有 Token" },
    { clientSecret: "不提供隐式认证方式" },
  ])("拒绝不明确或含凭据的认证配置 %#", (patch) => {
    expect(() => validateConfig(project({ oauth: { ...oauth, ...patch } }))).toThrow(
      ConfigValidationError,
    );
  });

  it.each(["Authorization", "AUTHORIZATION"])("OAuth 与 %s 引用不能争用身份", (name) => {
    expect(() =>
      validateConfig(project({ headers: { [name]: { env: "MCP_HEADER_TOKEN" } } })),
    ).toThrow(ConfigValidationError);
  });

  it("保留非认证 Header 和空 scope 集合的合法组合", () => {
    expect(
      validateConfig(
        project({ oauth: { ...oauth, scopes: [] }, headers: { "X-Client": "CoreMind" } }),
      ),
    ).toMatchObject({ mcp: { servers: { remote: { oauth: { scopes: [] } } } } });
  });
});
