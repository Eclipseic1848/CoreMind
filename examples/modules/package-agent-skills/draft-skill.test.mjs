import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resolveSelectedSkills } from "coremind-templates/internal";
import { draftSkill } from "./draft-skill.mjs";

test("任务说明生成可编辑草稿，只有显式选择后才进入技能索引", async (t) => {
  const project = await mkdtemp(path.join(tmpdir(), "coremind-draft-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const drafts = path.join(project, "drafts");
  const id = "review-changes";
  const task = '整理资料变化："按页码"引用\n---\n仅使用已确认的资料。';
  const file = await draftSkill(drafts, id, task);
  const draft = await readFile(file, "utf8");
  assert.ok(draft.includes(task));
  const description = task.replace(/\s+/gu, " ");
  assert.ok(draft.includes(`正例：请完成这项任务并提交结果——${description}`));
  assert.ok(draft.includes(`反例：请原样转述下面的任务说明，到此为止——${description}`));
  assert.match(draft, /应触发：使用者要求执行/u);
  assert.match(draft, /不应触发：使用者只要求转述/u);
  assert.deepEqual((await resolveSelectedSkills([id], project)).missing, [id]);

  await assert.rejects(draftSkill(drafts, id, "覆盖现有草稿"), { code: "EEXIST" });
  assert.equal(await readFile(file, "utf8"), draft);
  await assert.rejects(draftSkill(drafts, "../outside", task), /ID/);
  await assert.rejects(draftSkill(drafts, "weekly-report", task), /冲突/);
  await assert.rejects(draftSkill(drafts, "empty-task", " "), /非空/);

  await writeFile(file, `${draft}\n负责人要求每条变化引用资料版本。\n`, "utf8");
  await mkdir(path.join(project, "skills"));
  await rename(path.dirname(file), path.join(project, "skills", id));
  assert.deepEqual((await resolveSelectedSkills([], project)).standard, []);
  const { standard } = await resolveSelectedSkills([id], project);
  assert.equal(standard.length, 1);
  assert.equal(standard[0].description, description);
  assert.match(standard[0].body, /每条变化引用资料版本/);
});
