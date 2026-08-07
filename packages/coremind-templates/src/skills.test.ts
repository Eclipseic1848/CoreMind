import { describe, expect, it } from "vitest";
import { findSkill, resolveSkills, SKILLS } from "./skills.js";

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
});
