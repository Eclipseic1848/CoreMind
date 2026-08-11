/** 只根据工程文件证据判断；混合工程返回 undefined，交给用户选择。 */
export declare function detectProjectLanguage(target: string): Promise<ProjectLanguage | undefined>;

/** 按 id 查找技能 */
export declare function findSkill(id: string): SkillMeta | undefined;

/** 按 id 查找模板 */
export declare function findTemplate(id: string): TemplateMeta | undefined;

/**
 * 扫描目录下的自定义技能（生态机制）：每个含 README.md 的子目录即一个技能，
 * 目录名 = 技能 id。目录不存在或为空时返回空 Map。
 */
export declare function loadDirectorySkills(dir: string): Promise<Map<string, string>>;

export declare interface ProjectGuidanceOptions {
    target: string;
    projectName: string;
    language: ProjectLanguage;
}

export declare type ProjectLanguage = "typescript" | "javascript" | "python";

/** 批量解析技能：返回注入内容与未命中 id（未命中由运行时告警） */
export declare function resolveSkills(ids: string[]): {
    contents: string[];
    missing: string[];
};

/** 生成项目级开发合同；已存在文件绝不覆盖。 */
export declare function scaffoldProjectGuidance(options: ProjectGuidanceOptions): Promise<string[]>;

/** 技能元数据：Markdown 资产 + 索引（内容即专业技能 SOP） */
export declare interface SkillMeta {
    /** 技能 id（目录名） */
    id: string;
    /** 显示名 */
    name: string;
    description: string;
    /** 技能内容（skills/<id>/README.md 全文，运行时注入 agent 系统提示词） */
    content: string;
}

/** 内置技能清单（首批 3 个，对应模板能力提炼） */
export declare const SKILLS: SkillMeta[];

/** 模板分类 */
export declare type TemplateCategory = "general" | "coding" | "industry" | "workflow";

export declare interface TemplateMeta {
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

/** 模板元数据清单（CLI 的 create/list-templates 依赖） */
export declare const TEMPLATES: TemplateMeta[];

export { }
