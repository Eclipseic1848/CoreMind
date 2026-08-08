import { existsSync, statSync } from "node:fs";
import path from "node:path";

const REPOSITORY_URL = "https://github.com/Eclipseic1848/CoreMind";

/** 把越过 docs 根目录的相对链接改写为 GitHub 源码链接。 */
export function rewriteDocumentationLink(href, relativePagePath, repositoryRoot) {
  if (!href || href.startsWith("#") || href.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(href)) {
    return href;
  }

  const [target, fragment] = splitFragment(href);
  if (!target.startsWith("../")) return href;

  const normalizedPage = relativePagePath.replaceAll("\\", "/");
  const repositoryPath = path.posix.normalize(
    path.posix.join("docs", path.posix.dirname(normalizedPage), target),
  );
  if (
    (repositoryPath === "docs" || repositoryPath.startsWith("docs/")) &&
    repositoryPath.endsWith(".md")
  ) {
    return href;
  }
  if (repositoryPath === ".." || repositoryPath.startsWith("../")) return href;

  const absoluteTarget = path.resolve(repositoryRoot, ...repositoryPath.split("/"));
  const absoluteRoot = path.resolve(repositoryRoot);
  const rootPrefix = `${absoluteRoot}${path.sep}`;
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(rootPrefix)) return href;

  const kind =
    existsSync(absoluteTarget) && statSync(absoluteTarget).isDirectory() ? "tree" : "blob";
  return `${REPOSITORY_URL}/${kind}/main/${repositoryPath}${fragment}`;
}

function splitFragment(href) {
  const index = href.indexOf("#");
  if (index < 0) return [href, ""];
  return [href.slice(0, index), href.slice(index)];
}
