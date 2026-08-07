import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findSkill, loadDirectorySkills, resolveSkills, SKILLS } from "./skills.js";

describe("SKILLS（技能索引）", () => {
  it("内置技能齐全且内容非空", () => {
    expect(SKILLS.length).toBeGreaterThanOrEqual(3);
    for (const skill of SKILLS) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.content.length).toBeGreaterThan(100);
      expect(skill.content).toContain("#");
    }
  });

  it("findSkill 按 id 查找", () => {
    expect(findSkill("code-review")?.name).toBe("代码审查");
    expect(findSkill("no-such-skill")).toBeUndefined();
  });

  it("resolveSkills 返回注入内容与未命中 id", () => {
    const r = resolveSkills(["code-review", "ghost", "translation"]);
    expect(r.contents).toHaveLength(2);
    expect(r.missing).toEqual(["ghost"]);
  });

  it("loadDirectorySkills 发现目录技能（生态机制）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-skills-"));
    mkdirSync(path.join(dir, "my-skill"));
    writeFileSync(path.join(dir, "my-skill", "README.md"), "# 我的技能\n内容", "utf8");
    mkdirSync(path.join(dir, "no-readme")); // 无 README 的子目录应被跳过
    writeFileSync(path.join(dir, "not-a-dir.txt"), "x", "utf8");

    const skills = await loadDirectorySkills(dir);
    expect(skills.size).toBe(1);
    expect(skills.get("my-skill")).toContain("我的技能");
    expect(skills.has("no-readme")).toBe(false);
  });

  it("loadDirectorySkills 目录不存在时返回空", async () => {
    const skills = await loadDirectorySkills(path.join(tmpdir(), "no-such-skills-dir-xyz"));
    expect(skills.size).toBe(0);
  });
});
