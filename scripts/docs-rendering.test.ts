import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMarkdownRenderer, disposeMdItInstance } from "vitepress";
import { afterAll, expect, it } from "vitest";
import { compileTemplate } from "vue/compiler-sfc";
import siteConfig from "../docs/.vitepress/config.mjs";

afterAll(() => disposeMdItInstance());

function compile(source: string) {
  return compileTemplate({
    ...siteConfig.vue?.template,
    source,
    filename: "documentation-rendering.vue",
    id: "documentation-rendering",
  });
}

it("文档配置保留主题标题的真实 Vue 插值", () => {
  const { code, errors } = compile("<a>{{ site.title }}</a>");
  expect(errors).toEqual([]);
  expect(code).toContain("_ctx.site.title");
  expect(code).not.toContain('"{{ site.title }}"');
});

it.each([
  ["正文提交占位符", "Commit: {{RELEASE_COMMIT}}", "{{RELEASE_COMMIT}}"],
  ["行内配置变量", "变量 `{{<saveAs>.text}}`", "{{<saveAs>.text}}"],
])("%s按字面保留，不作为 Vue 表达式", async (_name, markdown, literal) => {
  const renderer = await createMarkdownRenderer(path.resolve("docs"), siteConfig.markdown);
  const html = renderer.render(markdown, { relativePath: "release/notes/v1.1.0.md" });
  const { code, errors } = compile(`<main>${html}</main>`);
  expect(errors).toEqual([]);
  expect(code).toContain(literal);
  expect(code).not.toContain("_ctx.RELEASE_COMMIT");
  expect(code).not.toContain("_ctx.saveAs");
});

it("1.2 发布模板保留唯一提交占位符，并可编译双语正文", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const markdown = readFileSync(path.join(repositoryRoot, "docs/release/notes/v1.2.0.md"), "utf8");
  const renderer = await createMarkdownRenderer(
    path.join(repositoryRoot, "docs"),
    siteConfig.markdown,
  );
  const html = renderer.render(markdown, { relativePath: "release/notes/v1.2.0.md" });
  const { code, errors } = compile(`<main>${html}</main>`);
  expect(errors).toEqual([]);
  expect(markdown.match(/\{\{RELEASE_COMMIT\}\}/gu)).toHaveLength(1);
  expect(code).toContain("{{RELEASE_COMMIT}}");
  expect(code).toContain("简体中文");
  expect(code).toContain("English");
  expect(code).not.toContain("_ctx.RELEASE_COMMIT");
});
