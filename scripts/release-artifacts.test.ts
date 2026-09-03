import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createArtifactRecords,
  evaluateCandidateIdentity,
  evaluateReleaseIdentity,
  selectNpmDistTag,
  validateCertifiedRuntimeIdentity,
  validateCertifiedRuntimePackage,
  validateWaivedRuntimePackage,
} from "./release-artifacts.mjs";

describe("同提交发布物", () => {
  it("要求版本、标签、HEAD 与标签提交完全一致", () => {
    expect(
      evaluateReleaseIdentity({
        version: "0.2.0-rc.1",
        requestedTag: "v0.2.0-rc.1",
        headSha: "abc",
        tagSha: "abc",
        dirty: false,
      }),
    ).toEqual([]);
    expect(
      evaluateReleaseIdentity({
        version: "0.2.0-rc.1",
        requestedTag: "v0.2.0-rc.2",
        headSha: "abc",
        tagSha: "def",
        dirty: true,
      }).join("\n"),
    ).toContain("标签");
  });

  it("候选产物不要求 Tag，但仍拒绝脏工作区", () => {
    expect(evaluateCandidateIdentity({ dirty: false })).toEqual([]);
    expect(evaluateCandidateIdentity({ dirty: true })).toEqual(["Git 工作区不干净"]);
  });

  it("预发布版本使用 next，稳定版本使用 latest", () => {
    expect(selectNpmDistTag("0.2.0-rc.1")).toBe("next");
    expect(selectNpmDistTag("0.2.0-beta.2")).toBe("next");
    expect(selectNpmDistTag("0.2.0")).toBe("latest");
  });

  it("为实际文件生成相对路径、大小和 SHA-256", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "coremind-release-artifacts-"));
    mkdirSync(path.join(root, "npm"));
    const file = path.join(root, "npm", "coremind-config.tgz");
    writeFileSync(file, "artifact", "utf8");

    const records = await createArtifactRecords(root, [file]);

    expect(records).toEqual([
      {
        path: "npm/coremind-config.tgz",
        size: 8,
        sha256: createHash("sha256").update("artifact").digest("hex"),
      },
    ]);
  });

  it("网络豁免只接受获批的 coremind-runtime 包摘要", () => {
    const approved = "a".repeat(64);
    const artifacts = [
      { kind: "npm", name: "coremind-runtime", sha256: approved },
      { kind: "npm", name: "coremind-cli", sha256: "b".repeat(64) },
    ];

    expect(validateWaivedRuntimePackage(artifacts, approved)).toEqual([]);
    expect(validateWaivedRuntimePackage(artifacts, "c".repeat(64)).join("\n")).toContain(
      "摘要不一致",
    );
    expect(validateWaivedRuntimePackage([], approved).join("\n")).toContain("缺少");
  });

  it("严格 Provider 证据必须绑定当前版本、提交与最终 Runtime", () => {
    const certification = {
      version: "0.7.1",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      candidateArtifactSha256: "c".repeat(64),
      runtimeDigest: `sha256:${"d".repeat(64)}`,
    };
    expect(
      validateCertifiedRuntimeIdentity(certification, {
        version: "0.7.1",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "b".repeat(64),
        runtimeDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).toEqual([]);
    expect(
      validateCertifiedRuntimeIdentity(certification, {
        version: "0.7.1",
        commit: "e".repeat(40),
        runtimeArtifactSha256: "b".repeat(64),
        runtimeDigest: `sha256:${"d".repeat(64)}`,
      }).join("\n"),
    ).toContain("提交");
    expect(
      validateCertifiedRuntimePackage(
        [{ kind: "npm", name: "coremind-runtime", sha256: "c".repeat(64) }],
        certification.candidateArtifactSha256,
      ),
    ).toEqual([]);
    expect(validateCertifiedRuntimePackage([], certification.candidateArtifactSha256)).toHaveLength(
      1,
    );
  });
});
