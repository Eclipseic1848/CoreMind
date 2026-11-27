import { globSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewriteDocumentationLink } from "../../scripts/docs-link-policy.mjs";

const sourcePattern = /^modules\/[^?#]+\.en\.md$/u;
const sourcePath = (page) => page.replace(/^en\/(?=modules\/)/u, "");

export function englishModulePages(docsRoot) {
  return globSync("modules/**/*.en.md", { cwd: docsRoot })
    .map((page) => page.replaceAll("\\", "/"))
    .sort();
}

export function moduleDocumentationLink(href, page, repositoryRoot) {
  const source = sourcePath(page);
  const moved = source !== page && sourcePattern.test(source);
  if (!href || /^[#?]|^[a-z][a-z\d+.-]*:|^\/\//iu.test(href)) return href;
  const [target] = href.split(/[?#]/u, 1);
  const suffix = href.slice(target.length);
  const targetPath = target.startsWith("/")
    ? target.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(source), target));
  if (sourcePattern.test(targetPath)) return `/en/${targetPath}${suffix}`;
  const rewritten =
    rewriteDocumentationLink(target, moved ? source : page, repositoryRoot) + suffix;
  if (!moved || rewritten !== href || target.startsWith("/")) return rewritten;
  if (targetPath.endsWith(".md")) return `/${targetPath}${suffix}`;
  // 模块的清单等相邻文件由仓库提供，发布站点只构建 Markdown。
  return `https://github.com/Eclipseic1848/CoreMind/blob/main/docs/${targetPath}${suffix}`;
}

export function englishModuleSearchSections(docsRoot, file) {
  const page = path.relative(docsRoot, file).replaceAll("\\", "/");
  const source = sourcePath(page);
  if (source === page || !sourcePattern.test(source)) return undefined;
  // VitePress 1.6 的本地索引默认只读取物理 Markdown。动态英文路由直接读取同一份源文档。
  const markdown = readFileSync(path.join(docsRoot, source), "utf8");
  const title = /^#\s+(.+)$/mu.exec(markdown)?.[1] ?? path.posix.basename(source, ".en.md");
  return [{ titles: [title.trim()], text: markdown, anchor: "" }];
}

export async function writeEnglishModuleRedirects(docsRoot, output, base) {
  await Promise.all(
    englishModulePages(docsRoot).map(async (page) => {
      const file = path.join(output, page.replace(/\.md$/u, ".html"));
      const target = encodeURI(`${base}en/${page.replace(/\.md$/u, "")}`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        `<!doctype html><html lang="en-US"><head><meta charset="utf-8">
<link rel="canonical" href="${target}"><meta http-equiv="refresh" content="0; url=${target}">
<title>CoreMind Modules</title><script>location.replace(${JSON.stringify(target)} + location.search + location.hash)</script></head>
<body><a href="${target}">Open the English module page</a></body></html>\n`,
        "utf8",
      );
    }),
  );
}
