import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findTemplate, TEMPLATES, type TemplateMeta } from "coremind-templates";
import { flagString, type ParsedArgs } from "../args.js";
import { promptLine, select } from "../interactive.js";
import { cyan, dim, errorLine, green, yellow } from "../render.js";

/**
 * coremind create <name>：从模板生成新项目。
 * --template <id> 非交互；否则交互选择。
 */
export async function cmdCreate(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  let name = positionals[0];
  if (!name) {
    name = await promptLine("项目名称（目录名，如 my-agent）：");
  }
  if (!name) {
    console.error(errorLine("未提供项目名称"));
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(errorLine("项目名称只能包含小写字母、数字和连字符（以字母/数字开头）"));
    return 1;
  }

  // 选择模板
  let template: TemplateMeta | undefined;
  const templateId = flagString(parsed, "template") ?? flagString(parsed, "t");
  if (templateId) {
    template = findTemplate(templateId);
    if (!template) {
      console.error(
        errorLine(`模板 ${templateId} 不存在。可用：${TEMPLATES.map((t) => t.id).join("、")}`),
      );
      return 1;
    }
  } else {
    const index = await select(
      "选择场景模板：",
      TEMPLATES.map((t) => ({ label: `${t.id}`, description: t.description })),
    );
    if (index < 0) {
      console.log("已取消。");
      return 1;
    }
    template = TEMPLATES[index];
  }
  if (!template) {
    console.error(errorLine("模板解析失败"));
    return 1;
  }

  // 目标目录（当前目录下）
  const target = path.resolve(process.cwd(), name);
  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    console.error(
      errorLine(
        `无法创建目录 ${target}：${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return 1;
  }

  // 复制模板内容
  await cp(template.dir, target, { recursive: true, force: false });

  // 替换 coremind.yaml 中的 name / description 字段
  const yamlPath = path.join(target, "coremind.yaml");
  try {
    const yaml = await readFile(yamlPath, "utf8");
    const updated = yaml
      .replace(/^name:\s*.+$/m, `name: ${name}`)
      .replace(/^description:\s*.+$/m, `description: ${name}（基于 ${template.id} 模板创建）`);
    await writeFile(yamlPath, updated, "utf8");
  } catch (error) {
    console.warn(
      yellow(`⚠ 无法更新配置文件 name：${error instanceof Error ? error.message : String(error)}`),
    );
  }

  // 生成 .env.example（requiresEnv 合并 DEEPSEEK_API_KEY 模板默认）
  const envKeys = Array.from(new Set([...template.requiresEnv, "DEEPSEEK_API_KEY"]));
  const envExample = envKeys.map((key) => `${key}=`).join("\n");
  try {
    await writeFile(path.join(target, ".env.example"), `${envExample}\n`, "utf8");
  } catch {
    // 忽略
  }

  console.log(green(`\n✓ 已创建项目：${target}`));
  console.log(dim(`  模板：${template.id}（${template.description}）`));
  console.log("");
  console.log("下一步：");
  console.log(`  1. ${cyan(`cd ${name}`)}`);
  console.log(
    `  2. 复制环境变量：${cyan("copy .env.example .env")} 并填入 ${template.requiresEnv.join("、")}`,
  );
  console.log(`  3. 运行：${cyan(`coremind run coremind.yaml --prompt "你的第一个任务"`)}`);
  return 0;
}
