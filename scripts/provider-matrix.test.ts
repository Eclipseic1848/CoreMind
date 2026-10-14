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
      targetVersion: "0.7.0",
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
          commit: "a".repeat(40),
          runtimeArtifactSha256: "b".repeat(64),
          evidence: "artifacts/providers/alpha.json",
          checks: [
            "streaming",
            "tool-call",
            "structured-result",
            "multi-turn",
            "abort",
            "error",
            "long-context",
          ],
        },
      ],
      generatedAt: "2026-08-08",
      targetVersion: "0.2.0-rc.1",
    });

    expect(matrix.providers[0]?.status).toBe("certified");
    expect(matrix.providers[0]?.testedVersion).toBe("0.2.0-rc.1");
    expect(matrix.providers[0]?.testedCommit).toBe("a".repeat(40));
    expect(matrix.providers[0]?.runtimeArtifactSha256).toBe("b".repeat(64));
    expect(matrix.summary.certified).toBe(1);
  });

  it("兼容别名保留目录归属，但不复用主入口的认证证据", () => {
    const matrix = buildProviderMatrix({
      providers: [
        { id: "azure", defaultModel: "m1", modelCount: 2 },
        { id: "azure-openai-responses", defaultModel: "m1", modelCount: 2, aliasOf: "azure" },
      ],
      certifications: [
        {
          id: "azure",
          version: "0.2.0-rc.1",
          testedAt: "2026-08-08",
          model: "m1",
          commit: "a".repeat(40),
          runtimeArtifactSha256: "b".repeat(64),
          evidence: "artifacts/providers/azure.json",
          checks: [
            "streaming",
            "tool-call",
            "structured-result",
            "multi-turn",
            "abort",
            "error",
            "long-context",
          ],
        },
      ],
      generatedAt: "2026-08-08",
      targetVersion: "0.2.0-rc.1",
    });

    expect(matrix.providers.find((item) => item.id === "azure")?.status).toBe("certified");
    expect(matrix.providers.find((item) => item.id === "azure-openai-responses")).toMatchObject({
      aliasOf: "azure",
      modelCount: 2,
      status: "inherited-unverified",
    });
    expect(matrix.summary).toEqual({ supported: 2, certified: 1, unverified: 1 });
  });

  it("旧版或缺字段证据保留缺口，但只能标记为可配置未认证", () => {
    const matrix = buildProviderMatrix({
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
      targetVersion: "0.7.0",
    });

    expect(matrix.providers[0]).toMatchObject({
      status: "inherited-unverified",
      certificationGap: expect.arrayContaining(["abort", "long-context", "version"]),
    });
    expect(matrix.summary.certified).toBe(0);
  });

  it("0.7.0 的旧七项证据不能替代真实父子 Agent 产品链", () => {
    const matrix = buildProviderMatrix({
      providers: [{ id: "alpha", defaultModel: "a1", modelCount: 1 }],
      certifications: [
        {
          id: "alpha",
          version: "0.7.0",
          testedAt: "2026-08-31",
          model: "a1",
          commit: "a".repeat(40),
          runtimeArtifactSha256: "b".repeat(64),
          evidence: "artifacts/providers/alpha.json",
          checks: [
            "streaming",
            "tool-call",
            "structured-result",
            "multi-turn",
            "abort",
            "error",
            "long-context",
          ],
        },
      ],
      generatedAt: "2026-08-31",
      targetVersion: "0.7.0",
    });

    expect(matrix.providers[0]).toMatchObject({
      status: "inherited-unverified",
      certificationGap: expect.arrayContaining([
        "parent-model-call",
        "delegation-tool",
        "child-model-call",
        "child-tool-call",
        "cancel-convergence",
      ]),
    });
  });

  it("完整旧版证据不能冒充当前候选认证", () => {
    const matrix = buildProviderMatrix({
      providers: [{ id: "alpha", defaultModel: "a1", modelCount: 1 }],
      certifications: [
        {
          id: "alpha",
          version: "0.3.2",
          testedAt: "2026-08-08",
          model: "a1",
          commit: "a".repeat(40),
          runtimeArtifactSha256: "b".repeat(64),
          evidence: "artifacts/providers/alpha.json",
          checks: [
            "streaming",
            "tool-call",
            "structured-result",
            "multi-turn",
            "abort",
            "error",
            "long-context",
          ],
        },
      ],
      generatedAt: "2026-08-08",
      targetVersion: "0.7.0",
    });

    expect(matrix.targetVersion).toBe("0.7.0");
    expect(matrix.providers[0]).toMatchObject({
      status: "inherited-unverified",
      previousCertification: { version: "0.3.2" },
    });
    expect(matrix.summary.certified).toBe(0);
  });
});
