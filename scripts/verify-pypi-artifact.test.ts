import { describe, expect, it } from "vitest";
import { decideExistingPyPiArtifact } from "./verify-pypi-artifact.mjs";

describe("PyPI 断点发布判定", () => {
  it("只跳过同名且 SHA-256 一致的 wheel", () => {
    const releases = [
      { filename: "coremind_ai-0.3.0rc2-py3-none-any.whl", digests: { sha256: "same" } },
    ];
    expect(
      decideExistingPyPiArtifact("same", releases, "coremind_ai-0.3.0rc2-py3-none-any.whl"),
    ).toBe("skip-identical");
    expect(
      decideExistingPyPiArtifact("other", releases, "coremind_ai-0.3.0rc2-py3-none-any.whl"),
    ).toBe("conflict");
    expect(decideExistingPyPiArtifact("same", releases, "other.whl")).toBe("publish");
  });
});
