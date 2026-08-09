import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".scratch",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "coverage-loop",
  "dist",
  "node_modules",
  "release-artifacts",
  "venv",
]);

const FORBIDDEN_IDENTIFIER =
  /\bpi\b|pi[-_ ](?:agent|ai|coding)|@earendil-works|github\.com\/earendil-works/iu;

/** 审计仓库维护的全部 Markdown，不进入依赖、缓存、覆盖率或构建产物目录。 */
export async function auditMarkdownTree(root) {
  const blockers = [];
  const files = await collectMarkdownFiles(root);

  for (const file of files) {
    const relative = normalizePath(path.relative(root, file));
    let content;
    try {
      const bytes = await readFile(file);
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      blockers.push({
        code: "invalid-utf8",
        file: relative,
        message: `不是严格 UTF-8：${message(error)}`,
      });
      continue;
    }

    if (content.trim().length === 0) {
      blockers.push({ code: "empty-markdown", file: relative, message: "Markdown 文件为空" });
    }
    if (FORBIDDEN_IDENTIFIER.test(content)) {
      blockers.push({
        code: "forbidden-identifier",
        file: relative,
        message: "包含禁止公开的底层运行库标识",
      });
    }
    if (content.includes("\uFFFD")) {
      blockers.push({
        code: "replacement-character",
        file: relative,
        message: "包含 Unicode 替换字符，可能存在乱码",
      });
    }

    const searchable = removeCode(content);
    for (const link of extractLinks(searchable)) {
      const destination = normalizeDestination(link.target);
      if (!destination || isNonFileDestination(destination)) continue;

      let decoded;
      try {
        decoded = decodeURIComponent(destination);
      } catch {
        blockers.push({
          code: "invalid-link-encoding",
          file: relative,
          line: lineNumber(searchable, link.index),
          target: destination,
          message: "本地链接包含无效的 URI 编码",
        });
        continue;
      }

      const target = path.resolve(path.dirname(file), decoded.replaceAll("/", path.sep));
      if (!(await exists(target))) {
        blockers.push({
          code: "broken-local-link",
          file: relative,
          line: lineNumber(searchable, link.index),
          target: destination,
          message: "本地链接目标不存在",
        });
      }
    }
  }

  return { files: files.length, blockers };
}

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(target)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(target);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function removeCode(content) {
  return content
    .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2(?=\n|$)/g, "$1")
    .replace(/`[^`\n]*`/g, "");
}

function extractLinks(content) {
  const links = [];
  const inline = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+(?:\s+["'][^"']*["'])?)\)/g;
  for (const match of content.matchAll(inline)) {
    links.push({ target: match[1], index: match.index ?? 0 });
  }
  const reference = /^[ \t]*\[[^\]]+\]:[ \t]*(<[^>]+>|\S+)/gm;
  for (const match of content.matchAll(reference)) {
    links.push({ target: match[1], index: match.index ?? 0 });
  }
  return links;
}

function normalizeDestination(raw) {
  const trimmed = raw.trim();
  const withoutTitle = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : trimmed.split(/\s+["']/u, 1)[0];
  return withoutTitle.split("#", 1)[0].trim();
}

function isNonFileDestination(target) {
  return (
    target.startsWith("#") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target)
  );
}

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(file) {
  return file.replaceAll(path.sep, "/");
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
