import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pairs = [
  ["docs/index.md", "docs/en/index.md"],
  ["docs/providers/README.zh-CN.md", "docs/providers/README.en.md"],
  ["docs/providers/CERTIFICATION.zh-CN.md", "docs/providers/CERTIFICATION.en.md"],
  ["docs/release/README.zh-CN.md", "docs/release/README.en.md"],
  ["CONTRIBUTING.md", "CONTRIBUTING.en.md"],
  ["SECURITY.md", "SECURITY.en.md"],
  ["CODE_OF_CONDUCT.md", "docs/en/community-code-of-conduct.md"],
  ["CHANGELOG.md", "CHANGELOG.en.md"],
  ...["01-quickstart", "02-configuration", "03-skills", "04-quality", "05-cli-usage"].map(
    (name) => [`docs/guide/${name}.md`, `docs/en/guide/${name}.md`],
  ),
];

const missing = pairs.flat().filter((file) => !existsSync(path.join(root, file)));
if (missing.length > 0) {
  console.error(`文档站缺少文件：\n- ${missing.join("\n- ")}`);
  process.exit(1);
}
console.log(`文档站配对检查通过：${pairs.length} 组中英文材料。`);
