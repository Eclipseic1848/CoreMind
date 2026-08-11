import { describe, expect, it } from "vitest";
import { inspectRuntimeCompatibility } from "./dependency-adapter.js";

describe("低层运行依赖 Adapter", () => {
  it("以 CoreMind 自有结构报告锁步版本、能力和错误映射", () => {
    expect(inspectRuntimeCompatibility()).toEqual({
      dependencyFamily: "0.84.1",
      adapterVersion: 1,
      errorMappingVersion: 1,
      capabilities: {
        streaming: true,
        toolCalls: true,
        abort: true,
        usage: true,
        errors: true,
        timeouts: true,
      },
    });
  });
});
