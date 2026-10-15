import { describe, expect, it } from "vitest";
import { parseProtocolRequest } from "./index.js";

describe("v1 工具发现仅开放受限初始化能力", () => {
  const initialize = {
    jsonrpc: "2.0",
    id: "discovery-init",
    method: "initialize",
    params: { protocolVersion: "1.0", config: { schemaVersion: 2 } },
  };

  it("旧初始化保持原形状，显式能力只接受唯一 toolDiscovery", () => {
    expect(parseProtocolRequest(initialize)).toEqual(initialize);
    const negotiated = {
      ...initialize,
      params: { ...initialize.params, capabilities: ["toolDiscovery"] },
    };
    expect(parseProtocolRequest(negotiated)).toEqual(negotiated);
  });

  it.each(
    [
      [],
      ["mcpAuthentication"],
      ["toolDiscovery", "mcpAuthentication"],
      ["toolDiscovery", "toolDiscovery"],
      "toolDiscovery",
    ].map((capabilities) => ({ capabilities })),
  )("拒绝非受限能力形状 $capabilities", ({ capabilities }) => {
    expect(() =>
      parseProtocolRequest({
        ...initialize,
        params: { ...initialize.params, capabilities },
      }),
    ).toThrow();
  });
});
