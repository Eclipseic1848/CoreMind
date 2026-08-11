import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditMarkdownTree } from "./markdown-audit-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = await auditMarkdownTree(root);

if (report.blockers.length > 0) {
  console.error(
    `Markdown 审计失败（${report.blockers.length} 项，已检查 ${report.files} 个文件）：`,
  );
  for (const blocker of report.blockers) {
    const location = blocker.line ? `${blocker.file}:${blocker.line}` : blocker.file;
    const target = blocker.target ? ` -> ${blocker.target}` : "";
    console.error(`- [${blocker.code}] ${location}${target}：${blocker.message}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Markdown 审计通过：${report.files} 个文件，严格 UTF-8、本地链接、标识边界与中英文段落边界均有效。`,
  );
}
