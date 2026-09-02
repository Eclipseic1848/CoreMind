import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditMarkdownTree } from "./markdown-audit-lib.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "coremind-markdown-audit-"));
  temporaryDirectories.push(root);
  return root;
}

describe("全仓 Markdown 审计", () => {
  it("检查本地链接并忽略外部链接和代码块", async () => {
    const root = await createRoot();
    await mkdir(path.join(root, "docs", "folder"), { recursive: true });
    await writeFile(path.join(root, "docs", "target.md"), "# Target\n", "utf8");
    await writeFile(
      path.join(root, "docs", "README.md"),
      [
        "[valid](target.md#start)",
        "[spaced](<folder/guide file.md>)",
        "[external](https://example.com)",
        "```md",
        "[example only](missing-in-code.md)",
        "```",
        "[missing](missing.md)",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(root, "docs", "folder", "guide file.md"), "# Guide\n", "utf8");

    const report = await auditMarkdownTree(root);

    expect(report.files).toBe(3);
    expect(report.auditedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "docs/README.md",
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      ]),
    );
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toMatchObject({
      code: "broken-local-link",
      file: "docs/README.md",
      target: "missing.md",
    });
  });

  it("阻止空文件、非法 UTF-8 和禁止公开的底层标识", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "empty.md"), "", "utf8");
    await writeFile(path.join(root, "brand.md"), "隐藏标识 pi-agent\n", "utf8");
    await writeFile(path.join(root, "invalid.md"), Uint8Array.from([0xc3, 0x28]));

    const report = await auditMarkdownTree(root);
    const codes = report.blockers.map((item) => item.code);

    expect(codes).toContain("empty-markdown");
    expect(codes).toContain("forbidden-identifier");
    expect(codes).toContain("invalid-utf8");
  });

  it("阻止同一描述段落在中文句子后继续附加英文句子", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "mixed.md"),
      [
        "# 混排示例",
        "",
        "运行结果使用统一终态。Run results use the same terminal states.",
        "",
        "SDK、CLI 和 JSONL 使用同一快照。",
      ].join("\n"),
      "utf8",
    );

    const report = await auditMarkdownTree(root);

    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "mixed-language-paragraph",
        file: "mixed.md",
        line: 3,
      }),
    );
  });

  it("允许中英文独立成段并保留常见英文技术名词", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "separated.md"),
      [
        "# CoreMind SDK",
        "",
        "CLI、SDK 和 JSONL 使用同一份 RunSnapshot。",
        "",
        "The CLI, SDK, and JSONL outputs use the same RunSnapshot.",
      ].join("\n"),
      "utf8",
    );

    const report = await auditMarkdownTree(root);

    expect(report.blockers).toEqual([]);
  });

  it("跳过依赖、构建与覆盖率目录", async () => {
    const root = await createRoot();
    for (const directory of ["node_modules", "dist", "coverage", ".git", ".scratch"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "ignored.md"), "pi-agent\n", "utf8");
    }
    await writeFile(path.join(root, "README.md"), "# Valid\n", "utf8");

    const report = await auditMarkdownTree(root);

    expect(report.files).toBe(1);
    expect(report.blockers).toEqual([]);
  });
});
