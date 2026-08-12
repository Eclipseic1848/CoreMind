import { access, cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  detectProjectLanguage,
  findTemplate,
  listSupportedProviders,
  type ProjectLanguage,
  scaffoldProjectGuidance,
  TEMPLATES,
  type TemplateMeta,
} from "coremind-ai";
import { flagString, type ParsedArgs } from "../args.js";
import { promptLine, select } from "../interactive.js";
import { cyan, dim, errorLine, green, yellow } from "../render.js";
import { providerStatusLabel } from "./list-providers.js";

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
  const existingPath = name === "." || name.includes("/") || name.includes("\\");
  if (!existingPath && !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(errorLine("项目名称只能包含小写字母、数字和连字符（以字母/数字开头）"));
    return 1;
  }

  const target = path.resolve(process.cwd(), name);
  const existingProject = (await directoryHasEntries(target)) && name !== undefined;
  const hadCoreMindConfig = await fileExists(path.join(target, "coremind.yaml"));
  const hadEnvExample = await fileExists(path.join(target, ".env.example"));
  const projectName = existingPath ? path.basename(target) : name;
  let language = parseLanguage(flagString(parsed, "language"));
  if (flagString(parsed, "language") && !language) {
    console.error(errorLine("--language 只能是 typescript、javascript 或 python"));
    return 1;
  }
  if (existingProject) {
    language ??= await detectProjectLanguage(target);
  }
  if (!language) {
    if (process.stdin.isTTY !== true) {
      console.error(
        errorLine("无法自动确定工程语言；请使用 --language typescript|javascript|python"),
      );
      return 1;
    }
    const languageIndex = await select("选择项目语言：", [
      { label: "TypeScript", description: "推荐，类型安全的 Node SDK" },
      { label: "JavaScript", description: "Node.js，无需 TypeScript 编译" },
      { label: "Python", description: "通过 Python SDK 调用统一 Node Runtime" },
    ]);
    language = (["typescript", "javascript", "python"] as const)[languageIndex];
    if (!language) {
      console.log("已取消。");
      return 1;
    }
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

  const provider = hadCoreMindConfig ? undefined : await selectProvider(parsed);
  if (!hadCoreMindConfig && !provider) return 1;

  // 目标目录（新项目）或已有工程目录
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
  if (!hadCoreMindConfig) {
    try {
      const yaml = await readFile(yamlPath, "utf8");
      const updated = applyProviderSelection(
        yaml
          .replace(/^name:\s*.+$/m, `name: ${projectName}`)
          .replace(
            /^description:\s*.+$/m,
            `description: ${projectName}（基于 ${template.id} 模板创建）`,
          ),
        provider!,
      );
      await writeFile(yamlPath, updated, "utf8");
    } catch (error) {
      console.warn(
        yellow(
          `⚠ 无法更新配置文件 name：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  if (provider) {
    const envExamplePath = path.join(target, ".env.example");
    if (hadEnvExample) {
      const existing = await readFile(envExamplePath, "utf8");
      const names = new Set(
        existing
          .split(/\r?\n/)
          .map((line) => line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
          .filter((value): value is string => Boolean(value)),
      );
      if (!names.has(provider.apiKeyEnv)) {
        const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
        await writeFile(envExamplePath, `${existing}${separator}${provider.apiKeyEnv}=\n`, "utf8");
      }
    } else {
      await writeFile(envExamplePath, `${provider.apiKeyEnv}=\n`, "utf8");
    }
  }

  const guidanceFiles = await scaffoldProjectGuidance({
    target,
    projectName,
    language,
  });

  console.log(green(`\n✓ 已创建项目：${target}`));
  console.log(dim(`  模板：${template.id}（${template.description}）`));
  console.log(dim(`  语言：${language}${existingProject ? "（已有工程自动检测/确认）" : ""}`));
  if (provider) {
    console.log(dim(`  Provider：${provider.id}（${providerStatusLabel(provider.id)}）`));
  }
  console.log(dim(`  项目指导材料：新增 ${guidanceFiles.length} 个文件`));
  console.log("");
  console.log("下一步：");
  console.log(`  1. ${cyan(existingPath ? `cd "${target}"` : `cd ${name}`)}`);
  const envName = provider?.apiKeyEnv ?? "coremind.yaml 中配置的 apiKeyEnv";
  console.log(
    `  2. 复制环境变量：${cyan(environmentCopyCommand(process.platform))} 并填入 ${envName}`,
  );
  console.log(`  3. 运行：${cyan(`coremind run coremind.yaml --prompt "你的第一个任务"`)}`);
  return 0;
}

interface ProviderSelection {
  id: string;
  apiKeyEnv: string;
  model?: string;
}

const PROVIDER_PRESETS: ProviderSelection[] = [
  {
    id: "alibaba-model-studio",
    model: "qwen-plus",
    apiKeyEnv: "DASHSCOPE_API_KEY",
  },
  { id: "deepseek", apiKeyEnv: "DEEPSEEK_API_KEY" },
  { id: "openai", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "moonshotai-cn", apiKeyEnv: "MOONSHOT_API_KEY" },
  { id: "zai", apiKeyEnv: "ZAI_API_KEY" },
  { id: "minimax-cn", apiKeyEnv: "MINIMAX_CN_API_KEY" },
  { id: "xiaomi", apiKeyEnv: "XIAOMI_API_KEY" },
];

async function selectProvider(parsed: ParsedArgs): Promise<ProviderSelection | undefined> {
  let id = flagString(parsed, "provider");
  if (!id) {
    if (process.stdin.isTTY !== true) {
      console.error(
        errorLine("未选择 Provider；请使用 --provider <id>，可先运行 coremind providers 查看清单"),
      );
      return undefined;
    }
    const index = await select("选择模型 Provider：", [
      ...PROVIDER_PRESETS.map((item) => ({
        label: item.id,
        description: providerStatusLabel(item.id),
      })),
      { label: "其他已支持 Provider", description: "手动输入 Provider id 和凭据环境变量" },
    ]);
    if (index < 0) {
      console.log("已取消。");
      return undefined;
    }
    id = PROVIDER_PRESETS[index]?.id ?? (await promptLine("Provider id："));
  }
  if (!id || !listSupportedProviders().includes(id)) {
    console.error(
      errorLine(`不支持的 Provider：${id ?? "（空）"}；请运行 coremind providers 查看清单`),
    );
    return undefined;
  }

  const preset = PROVIDER_PRESETS.find((item) => item.id === id);
  let apiKeyEnv = flagString(parsed, "api-key-env") ?? preset?.apiKeyEnv;
  if (!apiKeyEnv && process.stdin.isTTY === true) {
    apiKeyEnv = await promptLine("API key 环境变量名：");
  }
  if (!apiKeyEnv || !/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) {
    console.error(
      errorLine("请使用 --api-key-env 指定有效的环境变量名（例如 MY_PROVIDER_API_KEY）"),
    );
    return undefined;
  }
  const model = flagString(parsed, "model") ?? preset?.model;
  return { id, apiKeyEnv, ...(model ? { model } : {}) };
}

function applyProviderSelection(yaml: string, selection: ProviderSelection): string {
  const eol = yaml.includes("\r\n") ? "\r\n" : "\n";
  const lines = ["provider:", `  id: ${selection.id}`];
  if (selection.model) lines.push(`  model: ${selection.model}`);
  lines.push(`  apiKeyEnv: ${selection.apiKeyEnv}`);
  return yaml.replace(
    /^provider:\r?\n(?: {2}.+\r?\n)+(?=\r?\nagents:)/m,
    `${lines.join(eol)}${eol}`,
  );
}

export function environmentCopyCommand(platform: NodeJS.Platform): string {
  return platform === "win32" ? "Copy-Item .env.example .env" : "cp .env.example .env";
}

function parseLanguage(value: string | undefined): ProjectLanguage | undefined {
  return value === "typescript" || value === "javascript" || value === "python" ? value : undefined;
}

async function directoryHasEntries(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).length > 0;
  } catch {
    return false;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
