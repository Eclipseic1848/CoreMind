import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createUnifiedDiff, DiffLimitError, diffFiles } from "./unified-diff.js";

describe("统一 diff", () => {
  it("为文本生成标准 unified diff", () => {
    const patch = createUnifiedDiff("const value = 1;\n", "const value = 2;\n", {
      oldPath: "src/value.ts",
      newPath: "src/value.ts",
    });

    expect(patch).toContain("--- src/value.ts");
    expect(patch).toContain("+++ src/value.ts");
    expect(patch).toContain("-const value = 1;");
    expect(patch).toContain("+const value = 2;");
  });

  it("输入或输出超过上限时失败关闭", () => {
    expect(() => createUnifiedDiff("x".repeat(20), "", { maxInputBytes: 10 })).toThrow(
      DiffLimitError,
    );
    expect(() =>
      createUnifiedDiff("a\n", "b\n", { maxInputBytes: 100, maxOutputBytes: 10 }),
    ).toThrowError(expect.objectContaining({ code: "diff_output_limit" }));
  });

  it("读取两个普通文件且拒绝工作区外路径", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-file-diff-"));
    writeFileSync(path.join(cwd, "before.txt"), "before\n", "utf8");
    writeFileSync(path.join(cwd, "after.txt"), "after\n", "utf8");

    await expect(
      diffFiles({ cwd, beforePath: "before.txt", afterPath: "after.txt" }),
    ).resolves.toContain("+after");
    await expect(
      diffFiles({ cwd, beforePath: "../outside.txt", afterPath: "after.txt" }),
    ).rejects.toMatchObject({ code: "diff_path_outside_workspace" });
  });
});
