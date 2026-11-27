import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { englishModulePages } from "../../.vitepress/module-routes.mjs";

const docsRoot = fileURLToPath(new URL("../..", import.meta.url));

export default {
  paths: () =>
    englishModulePages(docsRoot).map((page) => ({
      params: { page: page.slice("modules/".length, -".md".length) },
      content: readFileSync(path.join(docsRoot, page), "utf8"),
    })),
};
