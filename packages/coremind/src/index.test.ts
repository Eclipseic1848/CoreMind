import { describe, expect, it } from "vitest";
import {
  CoreMindRuntime,
  PROTOCOL_VERSION,
  parseProtocolRequest,
  TEMPLATES,
  validateConfig,
} from "./index.js";

describe("coremind-ai 公共门面", () => {
  it("统一导出配置、Runtime、模板和 Protocol", () => {
    expect(validateConfig).toBeTypeOf("function");
    expect(CoreMindRuntime).toBeTypeOf("function");
    expect(TEMPLATES.length).toBeGreaterThan(0);
    expect(PROTOCOL_VERSION).toBe("1.0");
    expect(parseProtocolRequest).toBeTypeOf("function");
  });
});
