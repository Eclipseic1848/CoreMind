import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readStandardSkillPackage } from "coremind-templates/internal";
import { checkId } from "./install-skill.mjs";

export async function draftSkill(draftRoot, id, task) {
  checkId(id);
  const brief = task.trim();
  if (!brief) throw new Error("请提供非空的任务说明");
  const description = brief.replace(/\s+/gu, " ");
  const markdown = [
    "---",
    `name: ${JSON.stringify(id)}`,
    `description: ${JSON.stringify(description)}`,
    "---",
    "",
    "## 任务",
    "",
    brief,
    "",
    "## 适用与排除",
    "",
    "应触发：使用者要求执行上述任务并交付结果。",
    `正例：请完成这项任务并提交结果——${description}`,
    "",
    "不应触发：使用者只要求转述任务说明，未要求执行所描述的工作。",
    `反例：请原样转述下面的任务说明，到此为止——${description}`,
    "",
    "## 执行与验收",
    "",
    "1. 核对任务所需的输入。缺少资料时，向使用者指出缺口。",
    "2. 按任务中约定的范围和格式完成交付，只使用已经授权的资料和工具。",
    "3. 逐项核对结果与任务要求，标明尚未满足的要求。",
    "",
  ].join("\n");

  const dir = path.resolve(draftRoot, id);
  const file = path.join(dir, "SKILL.md");
  await mkdir(path.dirname(dir), { recursive: true });
  await mkdir(dir);
  try {
    await writeFile(file, markdown, { encoding: "utf8", flag: "wx" });
    await readStandardSkillPackage(dir, id);
  } catch (error) {
    if (error.code === "EEXIST") throw error;
    await rm(file, { force: true });
    await rmdir(dir);
    throw error;
  }
  return file;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 3)
    throw new Error("用法：node draft-skill.mjs <草稿目录> <Skill ID> <任务说明>");
  console.log(await draftSkill(...args));
}
