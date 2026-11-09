import { describe, expect, it } from "vitest";
import {
  inspectRuntimeCompatibility,
  isRetryableDependencyAssistantError,
} from "./dependency-adapter.js";

describe("低层运行依赖 Adapter", () => {
  it("以 CoreMind 自有结构报告锁步版本、能力和错误映射", () => {
    expect(inspectRuntimeCompatibility()).toEqual({
      dependencyFamily: "1.5.0",
      adapterVersion: 2,
      errorMappingVersion: 2,
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

  it("状态码只在独立数字边界触发重试，与上游边界规则一致", () => {
    const statuses = ["429", "500", "502", "503", "504", "520", "524"];
    const neighbors = ["", "a", "Z", "0", "9", "_", "-", " ", "\n", "中"];
    const standaloneStatus = /(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])/i;
    const messages = statuses.flatMap((status) =>
      neighbors.flatMap((left) => neighbors.map((right) => `(${left}${status}${right})`)),
    );
    messages.push(
      ...statuses.flatMap((left) => statuses.map((right) => `${left}${right}`)),
      "52429",
      "5000",
      "1503",
      "401 authentication failed request_id=req_011CU503xyz",
      "400 image exceeds 5242880 bytes",
    );
    for (const errorMessage of messages) {
      const message = Object.freeze({ role: "assistant", stopReason: "error", errorMessage });
      expect(isRetryableDependencyAssistantError(message), errorMessage).toBe(
        standaloneStatus.test(errorMessage),
      );
      expect(message.errorMessage).toBe(errorMessage);
    }
  });

  it.each([
    ["fetch failed request_id=req_011CU503xyz", true],
    ["network error 5242880", true],
    ["timeout 500429", true],
    ["rate limit 52429", true],
    ["insufficient_quota 503", false],
    ["billing 429 timeout", false],
    ["quota exceeded 503", false],
    ["", false],
  ])("保留原有文字分类与配额排除：%s", (errorMessage, expected) => {
    expect(
      isRetryableDependencyAssistantError({ role: "assistant", stopReason: "error", errorMessage }),
    ).toBe(expected);
  });

  it.each(["stop", "aborted", "toolUse", "length"])("终态 %s 不重试", (stopReason) => {
    expect(
      isRetryableDependencyAssistantError({
        role: "assistant",
        stopReason,
        errorMessage: "503 timeout",
      }),
    ).toBe(false);
  });
});
