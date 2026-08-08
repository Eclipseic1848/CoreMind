import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type ProjectLanguage = "typescript" | "javascript" | "python";

export interface ProjectGuidanceOptions {
  target: string;
  projectName: string;
  language: ProjectLanguage;
}

/** 只根据工程文件证据判断；混合工程返回 undefined，交给用户选择。 */
export async function detectProjectLanguage(target: string): Promise<ProjectLanguage | undefined> {
  const hasPackage = await exists(path.join(target, "package.json"));
  const hasTypeScript =
    (await exists(path.join(target, "tsconfig.json"))) || (await containsExtension(target, ".ts"));
  const hasPython =
    (await exists(path.join(target, "pyproject.toml"))) ||
    (await exists(path.join(target, "requirements.txt"))) ||
    (await containsExtension(target, ".py"));
  if (hasPython && hasPackage) return undefined;
  if (hasTypeScript) return "typescript";
  if (hasPython) return "python";
  if (hasPackage) return "javascript";
  return undefined;
}

/** 生成项目级开发合同；已存在文件绝不覆盖。 */
export async function scaffoldProjectGuidance(options: ProjectGuidanceOptions): Promise<string[]> {
  const files = projectFiles(options);
  const created: string[] = [];
  for (const [relative, content] of Object.entries(files)) {
    const destination = path.join(options.target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
      created.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return created;
}

function projectFiles(options: ProjectGuidanceOptions): Record<string, string> {
  const sourceFile =
    options.language === "python"
      ? "src/tools/example.py"
      : options.language === "javascript"
        ? "src/tools/example.js"
        : "src/tools/example.ts";
  return {
    [sourceFile]: toolSkeleton(options.language),
    "tests/README.md": `# ${options.projectName} 测试 / Tests\n\n- TODO：为每条已确认业务规则增加正例、反例和失败注入。\n- TODO: Add positive, negative, and failure-injection cases for every confirmed rule.\n`,
    "evals/scenarios.yaml": `schemaVersion: 1\nscenarios:\n  - id: happy-path\n    input: TODO（需业务负责人确认）\n    expected:\n      contains:\n        - TODO\n`,
    "docs/requirements.zh-CN.md": zhRequirements(options.projectName),
    "docs/requirements.en.md": enRequirements(options.projectName),
    "docs/architecture.zh-CN.md": zhArchitecture(options),
    "docs/architecture.en.md": enArchitecture(options),
    "docs/development-sop.zh-CN.md": zhDevelopmentSop(),
    "docs/development-sop.en.md": enDevelopmentSop(),
    "docs/testing-guide.zh-CN.md": zhTestingGuide(),
    "docs/testing-guide.en.md": enTestingGuide(),
    "docs/acceptance-checklist.zh-CN.md": zhAcceptance(),
    "docs/acceptance-checklist.en.md": enAcceptance(),
    "skills/project-agent/SKILL.md": projectSkill(options.projectName),
    ".coremind/decisions.md": `# 决策记录 / Decision Log\n\n记录业务负责人确认的范围、规则、权限和验收变化；不要让 Agent 自行扩大范围。\n\nRecord owner-approved scope, rule, permission, and acceptance changes.\n`,
    ".coremind/checkpoints/.gitkeep": "",
  };
}

function toolSkeleton(language: ProjectLanguage): string {
  if (language === "python") {
    return `"""业务工具骨架；字段和返回规则必须由业务负责人确认。"""\n\n\ndef example_tool(value: str) -> dict[str, str]:\n    # TODO（需业务负责人确认）：替换为真实业务逻辑。\n    return {"value": value}\n`;
  }
  if (language === "javascript") {
    return `import { defineTool } from "coremind-ai";\n\nexport const exampleTool = defineTool({\n  name: "example_tool",\n  description: "TODO（需业务负责人确认）",\n  parameters: {\n    type: "object",\n    properties: { value: { type: "string" } },\n    required: ["value"],\n    additionalProperties: false,\n  },\n  // TODO（需业务负责人确认）：替换为真实业务逻辑。\n  execute: async ({ value }) => ({ value }),\n});\n`;
  }
  return `import { defineTool } from "coremind-ai";\n\nexport const exampleTool = defineTool<{ value: string }>({\n  name: "example_tool",\n  description: "TODO（需业务负责人确认）",\n  parameters: {\n    type: "object",\n    properties: { value: { type: "string" } },\n    required: ["value"],\n    additionalProperties: false,\n  },\n  // TODO（需业务负责人确认）：替换为真实业务逻辑。\n  execute: async ({ value }) => ({ value }),\n});\n`;
}

function zhRequirements(name: string): string {
  return `# ${name} 需求\n\n## 业务目标\n\nTODO（需业务负责人确认）\n\n## 输入、输出与边界\n\nTODO（需业务负责人确认）\n\n## 不做什么\n\nTODO（需业务负责人确认）\n`;
}

function enRequirements(name: string): string {
  return `# ${name} Requirements\n\n## Business goal\n\nTODO (business owner confirmation required)\n\n## Inputs, outputs, and boundaries\n\nTODO (business owner confirmation required)\n\n## Non-goals\n\nTODO (business owner confirmation required)\n`;
}

function zhArchitecture(options: ProjectGuidanceOptions): string {
  return `# 架构\n\n- 语言：${options.language}\n- Agent 形态：TODO（由用户选择单 Agent、Workflow、Loop 或多 Agent）\n- 工具与权限：TODO（需业务负责人确认）\n- 预算与质量档：TODO（需业务负责人确认）\n`;
}

function enArchitecture(options: ProjectGuidanceOptions): string {
  return `# Architecture\n\n- Language: ${options.language}\n- Agent shape: TODO (user chooses single agent, workflow, loop, or multi-agent)\n- Tools and permissions: TODO (owner confirmation required)\n- Budgets and quality profile: TODO (owner confirmation required)\n`;
}

function zhDevelopmentSop(): string {
  return `# 开发 SOP\n\n1. 先确认业务目标、输入输出和失败条件。\n2. 选择最简单可验收的 Agent 形态。\n3. 先写场景测试，再实现工具和提示词。\n4. 使用 ask 或 assisted 权限完成开发。\n5. 检查 Trace、预算、checkpoint 和 diff。\n6. 运行 coremind check 与 coremind eval。\n7. 由业务负责人确认结果后再发布。\n`;
}

function enDevelopmentSop(): string {
  return `# Development SOP\n\n1. Confirm goals, inputs, outputs, and failure conditions.\n2. Choose the simplest testable agent shape.\n3. Write scenarios before tools and prompts.\n4. Develop in ask or assisted permission mode.\n5. Inspect trace, budgets, checkpoints, and diffs.\n6. Run coremind check and coremind eval.\n7. Require owner acceptance before release.\n`;
}

function zhTestingGuide(): string {
  return `# 测试指南\n\n至少覆盖正常输入、边界输入、工具失败、Provider 失败、权限拒绝、预算超限和恢复。业务评分规则必须由业务负责人提供。\n`;
}

function enTestingGuide(): string {
  return `# Testing Guide\n\nCover happy paths, boundaries, tool failures, provider failures, denied permissions, exceeded budgets, and recovery. Business scoring rules must come from the owner.\n`;
}

function zhAcceptance(): string {
  return `# 验收清单\n\n- [ ] 业务目标和非目标已确认\n- [ ] 失败不会伪装为成功\n- [ ] 权限、预算和网络策略已确认\n- [ ] 场景评测达到约定阈值\n- [ ] Trace、checkpoint、diff 和恢复证据可用\n- [ ] 业务负责人已签字确认\n`;
}

function enAcceptance(): string {
  return `# Acceptance Checklist\n\n- [ ] Goals and non-goals confirmed\n- [ ] Failures never masquerade as success\n- [ ] Permissions, budgets, and network policy confirmed\n- [ ] Scenario evaluation meets the agreed threshold\n- [ ] Trace, checkpoint, diff, and recovery evidence is available\n- [ ] Business owner signed off\n`;
}

function projectSkill(name: string): string {
  return `---\nname: ${name}-agent-development\ndescription: Build and verify this CoreMind project without inventing business rules.\n---\n\n# ${name} Agent Development\n\nRead docs/requirements.zh-CN.md or docs/requirements.en.md first. Ask the owner about every unresolved TODO. Keep scope and architecture user-controlled. Implement one scenario at a time, run tests, then run coremind check and coremind eval. Never bypass permission, audit, checkpoint, diff, or release blockers.\n`;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function containsExtension(target: string, extension: string): Promise<boolean> {
  for (const directory of [target, path.join(target, "src")]) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    if (entries.some((entry) => path.extname(entry).toLowerCase() === extension)) return true;
  }
  return false;
}
