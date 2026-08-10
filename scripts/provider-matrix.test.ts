import { describe, expect, it } from "vitest";
import { buildProviderMatrix } from "./provider-matrix-lib.mjs";

describe("Provider 认证矩阵", () => {
  it("按 id 排序，并且没有证据时只标记为继承未认证", () => {
    const matrix = buildProviderMatrix({
      providers: [
        { id: "zeta", defaultModel: "z1", modelCount: 2 },
        { id: "alpha", defaultModel: "a1", modelCount: 1 },
      ],
      certifications: [],
      generatedAt: "2026-08-08",
    });

    expect(matrix.providers.map((item) => item.id)).toEqual(["alpha", "zeta"]);
    expect(matrix.providers.every((item) => item.status === "inherited-unverified")).toBe(true);
    expect(matrix.summary.certified).toBe(0);
  });

  it("只有完整证据记录才能标记认证", () => {
    const matrix = buildProviderMatrix({
      providers: [{ id: "alpha", defaultModel: "a1", modelCount: 1 }],
      certifications: [
        {
          id: "alpha",
          version: "0.2.0-rc.1",
          testedAt: "2026-08-08",
          model: "a1",
          evidence: "artifacts/providers/alpha.json",
          checks: ["streaming", "tool-call", "structured-result", "multi-turn", "error"],
        },
      ],
      generatedAt: "2026-08-08",
    });

    expect(matrix.providers[0]?.status).toBe("certified");
    expect(matrix.providers[0]?.testedVersion).toBe("0.2.0-rc.1");
    expect(matrix.summary.certified).toBe(1);
  });

  it("缺少 CoreMind 版本的证据台账不能标记认证", () => {
    expect(() =>
      buildProviderMatrix({
        providers: [{ id: "alpha", defaultModel: "a1", modelCount: 1 }],
        certifications: [
          {
            id: "alpha",
            testedAt: "2026-08-08",
            model: "a1",
            evidence: "artifacts/providers/alpha.json",
            checks: ["streaming", "tool-call", "structured-result", "multi-turn", "error"],
          },
        ],
        generatedAt: "2026-08-08",
      }),
    ).toThrow("认证证据不完整");
  });
});
