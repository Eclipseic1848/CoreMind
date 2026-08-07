import path from "node:path";
import { fileURLToPath } from "node:url";

/** 模板分类 */
export type TemplateCategory = "general" | "coding" | "industry" | "workflow";

export interface TemplateMeta {
  /** 模板 id（目录名） */
  id: string;
  /** 显示名 */
  name: string;
  category: TemplateCategory;
  description: string;
  /** 需要的环境变量（如 DEEPSEEK_API_KEY） */
  requiresEnv: string[];
  /** 模板目录绝对路径 */
  dir: string;
}

// 模板目录（发布时 files 包含 templates/）
const templatesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");

function templateDir(category: TemplateCategory, id: string): string {
  return path.join(templatesRoot, category, id);
}

/** 模板元数据清单（CLI 的 create/list-templates 依赖） */
export const TEMPLATES: TemplateMeta[] = [
  {
    id: "translator",
    name: "中英翻译助手",
    category: "general",
    description: "中英互译，保持术语一致性，支持任意长文本分段处理",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("general", "translator"),
  },
  {
    id: "blog-writer",
    name: "博客写作助手",
    category: "general",
    description: "根据要点撰写博客/公众号文章并保存为 markdown 文件",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("general", "blog-writer"),
  },
  {
    id: "code-reviewer",
    name: "代码审查员",
    category: "coding",
    description: "审查指定文件，标记风险等级并给出修改建议",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("coding", "code-reviewer"),
  },
  {
    id: "bug-squasher",
    name: "Bug 歼灭师",
    category: "coding",
    description: "双 agent 协作：分析根因 → 实施修复 → 验证结果",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("coding", "bug-squasher"),
  },
  {
    id: "hr-interviewer",
    name: "面试官",
    category: "industry",
    description: "按岗位面试候选人，根据回答质量分路追问（switch 分支）",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("industry", "hr-interviewer"),
  },
  {
    id: "contract-reviewer",
    name: "合同审查律师",
    category: "industry",
    description: "逐条审查合同条款风险，输出 markdown 审查报告",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("industry", "contract-reviewer"),
  },
  {
    id: "weekly-report",
    name: "周报生成器",
    category: "workflow",
    description: "扫描本周代码变更并生成周报（parallel + if + 多 agent 全特性示范）",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("workflow", "weekly-report"),
  },
  {
    id: "customer-triage",
    name: "客服工单分诊",
    category: "workflow",
    description: "工单自动分类并起草回复（双 agent + switch 分类）",
    requiresEnv: ["DEEPSEEK_API_KEY"],
    dir: templateDir("workflow", "customer-triage"),
  },
];

/** 按 id 查找模板 */
export function findTemplate(id: string): TemplateMeta | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export {
  findSkill,
  loadDirectorySkills,
  resolveSkills,
  SKILLS,
  type SkillMeta,
} from "./skills.js";
