import { describe, expect, it } from "vitest";
import {
  assertCertificationSucceeded,
  createCertificationEvidence,
} from "./provider-certification.mjs";

describe("Provider 认证诊断", () => {
  it("失败时保留终态、错误码和上游诊断", () => {
    expect(() =>
      assertCertificationSucceeded(
        {
          outcome: {
            status: "failed",
            finishReason: "agent_failed",
            error: { code: "agent_failed", message: "403 AccessDenied.Unpurchased" },
          },
        },
        "流式场景",
      ),
    ).toThrow("流式场景失败：agent_failed / agent_failed / 403 AccessDenied.Unpurchased");
  });

  it("只为包含版本且三轮会话通过的完整结果生成证据", () => {
    const evidence = createCertificationEvidence({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.2.0-rc.1",
      testedAt: "2026-08-09T20:00:00.000Z",
      platform: "win32-x64",
      node: "v22.22.1",
      details: completeDetails(3),
    });

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      version: "0.2.0-rc.1",
      details: { multiTurn: { passed: true, turns: 3 } },
      checks: expect.arrayContaining(["abort", "long-context"]),
      secretsRecorded: false,
    });
  });

  it("拒绝缺少版本或不足三轮的认证证据", () => {
    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "",
        testedAt: "2026-08-09T20:00:00.000Z",
        platform: "win32-x64",
        node: "v22.22.1",
        details: completeDetails(3),
      }),
    ).toThrow("缺少 CoreMind 版本");
    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "0.2.0-rc.1",
        testedAt: "2026-08-09T20:00:00.000Z",
        platform: "win32-x64",
        node: "v22.22.1",
        details: completeDetails(2),
      }),
    ).toThrow("至少需要三轮");
  });
});

function completeDetails(turns: number) {
  return {
    streaming: { passed: true },
    toolCall: { passed: true },
    structuredResult: { passed: true },
    multiTurn: { passed: true, turns },
    abort: { passed: true },
    error: { passed: true },
    longContext: { passed: true },
  };
}
