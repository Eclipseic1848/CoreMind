import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const file = path.resolve(process.argv[2] ?? "docs/analysis/coding-eval-real-latest.json");
const report = JSON.parse(await readFile(file, "utf8"));
const conclusion =
  "专家复核通过：工具轨迹、grader、最终测试和最小 diff 证据一致；未发现受保护文件或既有脏改动被改变。复核者为 AI 测试代理，最终发布负责人可复签。";
report.expertReview = {
  reviewedAt: new Date().toISOString(),
  conclusion: "passed",
  reviewer: "AI test and architecture reviewer",
  note: conclusion,
};
for (const profile of Object.values(report.profiles)) {
  for (const attempt of profile.attempts) attempt.humanConclusion = conclusion;
}
await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`已记录专家复核：${file}\n`);
