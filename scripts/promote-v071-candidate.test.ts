import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { verifyCandidateFiles } from "./promote-v071-candidate.mjs";

it("复用前核对实际字节，拒绝篡改、缺件与路径越界", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-candidate-reuse-"));
  try {
    await mkdir(path.join(directory, "npm"));
    await writeFile(path.join(directory, "npm", "test.tgz"), "candidate", "utf8");
    const artifact = {
      path: "npm/test.tgz",
      size: 9,
      sha256: createHash("sha256").update("candidate").digest("hex"),
    };
    await expect(verifyCandidateFiles(directory, [artifact])).resolves.toBeUndefined();
    for (const change of [
      { size: 8 },
      { sha256: "0".repeat(64) },
      { path: "npm/missing.tgz" },
      { path: "../test.tgz" },
      { path: "npm/../../test.tgz" },
    ]) {
      await expect(verifyCandidateFiles(directory, [{ ...artifact, ...change }])).rejects.toThrow();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
