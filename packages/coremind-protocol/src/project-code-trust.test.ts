import { expect, it } from "vitest";
import { parseProtocolRequest } from "./index.js";
import { parseProtocolV2Request } from "./v2.js";

for (const protocol of ["1.0", "2.0"] as const) {
  for (const trustProjectCode of [false, true]) {
    it(`${protocol} initialize 白名单接受显式 boolean ${trustProjectCode}`, () => {
      const packet = {
        jsonrpc: "2.0",
        id: "trust",
        method: "initialize",
        params: {
          ...(protocol === "1.0"
            ? { protocolVersion: "1.0" }
            : { protocolRange: { minVersion: "2.0", maxVersion: "2.0" } }),
          config: { schemaVersion: 2, name: "probe", agents: { main: {} } },
          trustProjectCode,
        },
      };
      const parsed =
        protocol === "1.0" ? parseProtocolRequest(packet) : parseProtocolV2Request(packet);
      expect(parsed).toMatchObject({ params: { trustProjectCode } });
    });
  }
  for (const trustProjectCode of ["true", "false", 1, null]) {
    it(`${protocol} initialize 拒绝非 boolean ${trustProjectCode}`, () => {
      const packet = {
        jsonrpc: "2.0",
        id: "trust",
        method: "initialize",
        params: {
          ...(protocol === "1.0"
            ? { protocolVersion: "1.0" }
            : { protocolRange: { minVersion: "2.0", maxVersion: "2.0" } }),
          config: { schemaVersion: 2, name: "probe", agents: { main: {} } },
          trustProjectCode,
        },
      };
      expect(() =>
        protocol === "1.0" ? parseProtocolRequest(packet) : parseProtocolV2Request(packet),
      ).toThrow();
    });
  }
}
