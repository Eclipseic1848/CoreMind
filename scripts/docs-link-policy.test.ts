import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  englishModuleSearchSections,
  moduleDocumentationLink,
} from "../docs/.vitepress/module-routes.mjs";
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

  it("把英文模块及交叉链接送到正确语言的路由", () => {
    const page = "en/modules/manage-memory/SOP.en.md";
    expect(
      moduleDocumentationLink("../../modules/README.en.md", "en/guide/01-quickstart.md", root),
    ).toBe("/en/modules/README.en.md");
    expect(moduleDocumentationLink("../manage-knowledge/SOP.en.md#acceptance", page, root)).toBe(
      "/en/modules/manage-knowledge/SOP.en.md#acceptance",
    );
    expect(moduleDocumentationLink("./SOP.zh-CN.md", page, root)).toBe(
      "/modules/manage-memory/SOP.zh-CN.md",
    );
    expect(moduleDocumentationLink("module.yaml", page, root)).toBe(
      "https://github.com/Eclipseic1848/CoreMind/blob/main/docs/modules/manage-memory/module.yaml",
    );
    expect(
      moduleDocumentationLink(
        "../../../examples/modules/manage-memory/README.en.md#usage",
        page,
        root,
      ),
    ).toBe(
      "https://github.com/Eclipseic1848/CoreMind/blob/main/examples/modules/manage-memory/README.en.md#usage",
    );
  });

  it("为动态英文模块索引源正文，并保留中文页面默认索引", () => {
    const docs = path.join(root, "docs");
    expect(
      englishModuleSearchSections(docs, path.join(docs, "en/modules/manage-memory/SOP.en.md")),
    ).toEqual([
      expect.objectContaining({
        titles: ["Long-term memory development SOP"],
        text: expect.stringContaining("authorized new session can recall"),
      }),
    ]);
    expect(
      englishModuleSearchSections(docs, path.join(docs, "modules/manage-memory/SOP.zh-CN.md")),
    ).toBeUndefined();
  });
});
