import { type Dirent, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 技能元数据：Markdown 资产 + 索引（内容即专业技能 SOP） */
export interface SkillMeta {
  /** 技能 id（目录名） */
  id: string;
  /** 显示名 */
  name: string;
  description: string;
  /** 技能内容（skills/<id>/README.md 全文，运行时注入 agent 系统提示词） */
  content: string;
}

// 技能目录（发布时 files 包含 skills/）
const skillsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

function skillDir(id: string): string {
  return path.join(skillsRoot, id);
}

function loadSkill(id: string, name: string, description: string): SkillMeta {
  return {
    id,
    name,
    description,
    content: readFileSync(path.join(skillDir(id), "README.md"), "utf8"),
  };
}

/** 内置技能清单（首批 3 个，对应模板能力提炼） */
export const SKILLS: SkillMeta[] = [
  loadSkill("code-review", "代码审查", "按 SOP 审查代码：正确性/安全/性能/可维护性，输出分级结论"),
  loadSkill("weekly-report", "周报撰写", "按 SOP 生成结构化周报：收集维度/结构模板/价值导向写作"),
  loadSkill("translation", "翻译", "按 SOP 翻译：术语一致/格式保持/自检清单"),
];

/** 按 id 查找技能 */
export function findSkill(id: string): SkillMeta | undefined {
  return SKILLS.find((s) => s.id === id);
}

/** 批量解析技能：返回注入内容与未命中 id（未命中由运行时告警） */
export function resolveSkills(ids: string[]): { contents: string[]; missing: string[] } {
  const contents: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const skill = findSkill(id);
    if (skill) contents.push(skill.content);
    else missing.push(id);
  }
  return { contents, missing };
}

/**
 * 扫描目录下的自定义技能（生态机制）：每个含 README.md 的子目录即一个技能，
 * 目录名 = 技能 id。目录不存在或为空时返回空 Map。
 */
export async function loadDirectorySkills(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result; // 目录不存在（未使用自定义技能）→ 空
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const content = await readFile(path.join(dir, entry.name, "README.md"), "utf8").catch(
      () => null,
    );
    if (content) result.set(entry.name, content);
  }
  return result;
}
