import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createArtifactRecords,
  evaluateReleaseIdentity,
  selectNpmDistTag,
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
});
