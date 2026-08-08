import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteDocumentationLink } from "./docs-link-policy.mjs";

const root = path.resolve(".");

describe("文档站仓库链接策略", () => {
  it("保留 docs 内部相对链接", () => {
    expect(
      rewriteDocumentationLink("../guide/01-quickstart.md", "modules/README.zh-CN.md", root),
    ).toBe("../guide/01-quickstart.md");
  });

  it("把 docs 外部文件改写为 GitHub blob 链接并保留锚点", () => {
    expect(
      rewriteDocumentationLink(
        "../../../packages/coremind/src/index.ts#L1",
        "modules/contribute-coremind/README.zh-CN.md",
        root,
      ),
    ).toBe("https://github.com/Eclipseic1848/CoreMind/blob/main/packages/coremind/src/index.ts#L1");
  });

  it("把 docs 内不可渲染的源码文件改写为 GitHub 链接", () => {
    expect(
      rewriteDocumentationLink(
        "../../../docs/.vitepress/config.mts",
        "modules/contribute-coremind/README.zh-CN.md",
        root,
      ),
    ).toBe("https://github.com/Eclipseic1848/CoreMind/blob/main/docs/.vitepress/config.mts");
  });

  it("不改写外部 URL、锚点和绝对站内路由", () => {
    expect(rewriteDocumentationLink("https://example.com", "index.md", root)).toBe(
      "https://example.com",
    );
    expect(rewriteDocumentationLink("#start", "index.md", root)).toBe("#start");
    expect(rewriteDocumentationLink("/en/", "index.md", root)).toBe("/en/");
  });
});
