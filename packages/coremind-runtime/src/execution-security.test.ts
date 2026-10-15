import type { CoreMindConfig, McpHttpServerConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import { enforceExecutionSecurity, inspectExecutionSecurity } from "./execution-security.js";

function httpConfig(headers: NonNullable<McpHttpServerConfig["headers"]>): CoreMindConfig {
  return {
    schemaVersion: 2,
    name: "http-mcp-security",
    agents: { main: {} },
    mcp: {
      servers: {
        inventory: { transport: "streamable-http", url: "https://mcp.example.test/", headers },
      },
    },
  };
}

describe("HTTP MCP 配置安全门", () => {
  it.each([
    "Authorization",
    "X-Api-Key",
    "api-key",
    "X-Auth-Token",
    "x-access-token",
    "X-Goog-Api-Key",
    "x-amz-security-token",
    "COOKIE",
  ])("敏感 Header %s 的字面量在直接 Runtime 配置中也失败关闭", (name) => {
    const config = httpConfig({ [name]: "mcp-literal-never-log" });
    const findings = inspectExecutionSecurity(config);
    expect(findings).toContainEqual({
      code: "execution_security_violation",
      path: `mcp.servers.inventory.headers.${name}`,
      message: expect.stringContaining("不允许使用字面量"),
    });
    expect(() => enforceExecutionSecurity(config)).toThrow(
      expect.objectContaining({ code: "execution_security_violation" }),
    );
    expect(JSON.stringify(findings)).not.toContain("mcp-literal-never-log");
  });

  it("静态检查保留 Header 引用，不读取值或要求当前宿主存在凭据", () => {
    const config = httpConfig({
      Authorization: { env: "UNSET_MCP_TEST_TOKEN" },
      "X-Api-Key": { secretRef: "opaque/mcp/test-only" },
      "X-Client-Name": "CoreMind",
    });
    expect(inspectExecutionSecurity(config)).toEqual([]);
    expect(() => enforceExecutionSecurity(config)).not.toThrow();
  });
});
