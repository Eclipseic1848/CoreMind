import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modulesRoot = path.join(root, "docs", "modules");
const expectedModules = [
  "adapt-runtime-dependencies",
  "build-coding-agents",
  "build-tools",
  "configure-coremind",
  "contribute-coremind",
  "design-agents",
  "design-workflows",
  "embed-coremind-python",
  "embed-coremind-typescript",
  "enforce-agent-permissions",
  "evaluate-agents",
  "extend-runtime-lifecycle",
  "inspect-agent-traces",
  "manage-checkpoints",
  "manage-context-artifacts",
  "manage-providers",
  "manage-sessions",
  "operate-coremind-cli",
  "orchestrate-child-runs",
  "package-agent-skills",
  "recover-durable-runs",
  "scaffold-coremind-projects",
];
const expectedGoldenExamples = [
  "bounded-research-agent",
  "contract-review-workflow",
  "faq-order-assistant",
  "python-data-analysis",
  "verified-repair-loop",
];
const failures = [];

for (const id of expectedModules) {
  await checkModule(id);
}
await checkNoUnexpectedModules();
await checkGoldenExamples();
await checkExampleConfigs();
await checkMarkdownBrandBoundary();

if (failures.length > 0) {
  console.error(`模块合同检查失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `模块合同检查通过：${expectedModules.length} 个模块与 ${expectedGoldenExamples.length} 个黄金示例，双语材料、Skill、示例、测试与链接完整。`,
  );
}

async function checkModule(id) {
  const moduleDir = path.join(modulesRoot, id);
  const manifestFile = path.join(moduleDir, "module.yaml");
  if (!(await exists(manifestFile))) {
    failures.push(`${id} 缺少 module.yaml`);
    return;
  }
  let manifest;
  try {
    manifest = parse(await readFile(manifestFile, "utf8"));
  } catch (error) {
    failures.push(`${id}/module.yaml 无法解析：${message(error)}`);
    return;
  }
  if (!manifest || typeof manifest !== "object") {
    failures.push(`${id}/module.yaml 必须是对象`);
    return;
  }
  requireEqual(manifest.schemaVersion, 1, `${id}.schemaVersion`);
  requireEqual(manifest.id, id, `${id}.id`);
  requireString(manifest.name?.["zh-CN"], `${id}.name.zh-CN`);
  requireString(manifest.name?.en, `${id}.name.en`);
  requireString(manifest.version, `${id}.version`);
  requireOneOf(manifest.maturity, ["alpha", "beta", "release-candidate"], `${id}.maturity`);
  requireArrayContains(manifest.supportedPlatforms, "windows", `${id}.supportedPlatforms`);
  requireArrayContains(manifest.supportedPlatforms, "linux", `${id}.supportedPlatforms`);

  const bilingual = [
    [manifest.documents?.readme?.["zh-CN"], manifest.documents?.readme?.en, "README"],
    [manifest.documents?.sop?.["zh-CN"], manifest.documents?.sop?.en, "SOP"],
    [manifest.documents?.guide?.["zh-CN"], manifest.documents?.guide?.en, "GUIDE"],
  ];
  for (const [zh, en, label] of bilingual) {
    requireString(zh, `${id}.${label}.zh-CN`);
    requireString(en, `${id}.${label}.en`);
    await requirePath(zh, `${id}.${label}.zh-CN`);
    await requirePath(en, `${id}.${label}.en`);
  }

  await requirePath(manifest.documents?.changelog, `${id}.changelog`);
  if (typeof manifest.documents?.changelog === "string") {
    const changeText = await readFile(path.join(root, manifest.documents.changelog), "utf8");
    if (!changeText.includes(manifest.version)) {
      failures.push(`${id} CHANGELOG 未记录版本 ${manifest.version}`);
    }
  }
  await requirePath(manifest.skillPath, `${id}.skillPath`);
  for (const [index, value] of asArray(manifest.sourcePaths).entries()) {
    await requirePath(value, `${id}.sourcePaths[${index}]`);
  }
  for (const [index, value] of asArray(manifest.testPaths).entries()) {
    await requirePath(value, `${id}.testPaths[${index}]`);
  }
  for (const [index, value] of asArray(manifest.examplePaths).entries()) {
    await requirePath(value, `${id}.examplePaths[${index}]`);
  }
  if (asArray(manifest.sourcePaths).length === 0) failures.push(`${id} sourcePaths 不能为空`);
  if (asArray(manifest.testPaths).length === 0) failures.push(`${id} testPaths 不能为空`);
  if (asArray(manifest.examplePaths).length < 2) failures.push(`${id} 示例必须中英文成对`);
  for (const dependency of asArray(manifest.dependencies)) {
    if (!expectedModules.includes(dependency)) failures.push(`${id} 依赖未知模块 ${dependency}`);
  }

  if (
    typeof manifest.skillPath === "string" &&
    (await exists(path.join(root, manifest.skillPath)))
  ) {
    await checkSkill(id, path.join(root, manifest.skillPath));
  }
  const markdownFiles = [
    ...bilingual.flat(),
    manifest.skillPath,
    ...asArray(manifest.examplePaths),
  ].filter((value) => typeof value === "string");
  for (const file of markdownFiles) await checkMarkdownLinks(path.join(root, file));
}

async function checkSkill(id, file) {
  const content = await readFile(file, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    failures.push(`${id} SKILL.md frontmatter 无效`);
    return;
  }
  let frontmatter;
  try {
    frontmatter = parse(match[1]);
  } catch (error) {
    failures.push(`${id} SKILL.md frontmatter 无法解析：${message(error)}`);
    return;
  }
  if (frontmatter?.name !== id) failures.push(`${id} Skill name 必须与目录名一致`);
  requireString(frontmatter?.description, `${id} Skill description`);
  const extra = Object.keys(frontmatter ?? {}).filter(
    (key) => !["name", "description"].includes(key),
  );
  if (extra.length > 0) failures.push(`${id} Skill frontmatter 含多余字段：${extra.join(", ")}`);
  if (content.includes("[TODO")) failures.push(`${id} SKILL.md 仍含初始化占位符`);
  const openaiFile = path.join(path.dirname(file), "agents", "openai.yaml");
  if (!(await exists(openaiFile))) {
    failures.push(`${id} 缺少 agents/openai.yaml`);
    return;
  }
  const metadata = parse(await readFile(openaiFile, "utf8"));
  if (!metadata?.interface?.default_prompt?.includes(`$${id}`)) {
    failures.push(`${id} agents/openai.yaml 默认提示未显式引用 $${id}`);
  }
}

async function checkMarkdownLinks(file) {
  if (!(await exists(file))) return;
  const content = await readFile(file, "utf8");
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(pattern)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
    if (!target || /^(https?:|mailto:)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!(await exists(resolved))) {
      failures.push(`${path.relative(root, file)} 的链接不存在：${target}`);
    }
  }
}

async function checkMarkdownBrandBoundary() {
  const forbidden =
    /\bpi\b|pi[-_ ](?:agent|ai|coding)|@earendil-works|github\.com\/earendil-works/iu;
  for (const file of await collectMarkdownFiles(root)) {
    const content = await readFile(file, "utf8");
    if (forbidden.test(content)) {
      failures.push(`${path.relative(root, file)} 暴露了禁止出现在用户文档中的底层运行库标识`);
    }
  }
}

async function collectMarkdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && [".git", "node_modules", ".venv", "venv"].includes(entry.name)) {
      continue;
    }
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdownFiles(target)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(target);
  }
  return files;
}

async function checkNoUnexpectedModules() {
  const entries = await readdir(modulesRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && !expectedModules.includes(entry.name)) {
      failures.push(`发现未登记模块目录：${entry.name}`);
    }
  }
}

async function checkGoldenExamples() {
  const goldenRoot = path.join(root, "examples", "golden");
  for (const id of expectedGoldenExamples) {
    const exampleRoot = path.join(goldenRoot, id);
    const manifestFile = path.join(exampleRoot, "example.yaml");
    if (!(await exists(manifestFile))) {
      failures.push(`黄金示例 ${id} 缺少 example.yaml`);
      continue;
    }
    const manifest = parse(await readFile(manifestFile, "utf8"));
    requireEqual(manifest?.schemaVersion, 1, `黄金示例 ${id}.schemaVersion`);
    requireEqual(manifest?.id, id, `黄金示例 ${id}.id`);
    requireEqual(manifest?.offline, true, `黄金示例 ${id}.offline`);
    requireEqual(manifest?.qualityProfile, "standard", `黄金示例 ${id}.qualityProfile`);
    requireEqual(manifest?.minimumPassRate, 1, `黄金示例 ${id}.minimumPassRate`);
    const required = [
      manifest.configPath,
      manifest.scenarioPath,
      manifest.testPath,
      manifest.skillPath,
      manifest.documents?.["zh-CN"],
      manifest.documents?.en,
      manifest.documents?.sopZh,
      manifest.documents?.sopEn,
      manifest.documents?.failuresZh,
      manifest.documents?.failuresEn,
      "docs/requirements.zh-CN.md",
      "docs/requirements.en.md",
      "docs/architecture.zh-CN.md",
      "docs/architecture.en.md",
      "docs/development-sop.zh-CN.md",
      "docs/development-sop.en.md",
      "docs/testing-guide.zh-CN.md",
      "docs/testing-guide.en.md",
      "docs/acceptance-checklist.zh-CN.md",
      "docs/acceptance-checklist.en.md",
      "skills/project-agent/SKILL.md",
      ".coremind/decisions.md",
      "tests/README.md",
    ];
    for (const value of required) {
      if (typeof value !== "string" || !(await exists(path.resolve(exampleRoot, value)))) {
        failures.push(`黄金示例 ${id} 路径不存在：${String(value)}`);
      }
    }
    for (const value of asArray(manifest.implementationPaths)) {
      if (!(await exists(path.resolve(exampleRoot, value)))) {
        failures.push(`黄金示例 ${id} 实现路径不存在：${value}`);
      }
    }
    const skillFile = path.resolve(exampleRoot, manifest.skillPath ?? "");
    if (await exists(skillFile))
      await checkNamedSkill(skillFile, path.basename(path.dirname(skillFile)));
    await checkNamedSkill(
      path.join(exampleRoot, "skills", "project-agent", "SKILL.md"),
      "project-agent",
    );
    for (const file of required.filter(
      (value) => typeof value === "string" && value.endsWith(".md"),
    )) {
      await checkMarkdownLinks(path.resolve(exampleRoot, file));
    }
  }
  const entries = await readdir(goldenRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      entry.name !== "_shared" &&
      !expectedGoldenExamples.includes(entry.name)
    ) {
      failures.push(`发现未登记黄金示例：${entry.name}`);
    }
  }
}

async function checkNamedSkill(file, expectedName) {
  const content = await readFile(file, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    failures.push(`${path.relative(root, file)} frontmatter 无效`);
    return;
  }
  const frontmatter = parse(match[1]);
  if (frontmatter?.name !== expectedName) {
    failures.push(`${path.relative(root, file)} name 应为 ${expectedName}`);
  }
  requireString(frontmatter?.description, `${path.relative(root, file)} description`);
  if (content.includes("[TODO")) failures.push(`${path.relative(root, file)} 仍含初始化占位符`);
}

async function checkExampleConfigs() {
  let validateConfig;
  try {
    ({ validateConfig } = await import("coremind-config"));
  } catch (error) {
    failures.push(`无法加载已构建的 coremind-config：${message(error)}；请先运行 npm run build`);
    return;
  }
  const roots = [
    path.join(root, "examples"),
    path.join(root, "packages", "coremind-templates", "templates"),
  ];
  for (const directory of roots) {
    for (const file of await yamlFiles(directory)) {
      let value;
      try {
        value = parse(await readFile(file, "utf8"));
      } catch (error) {
        failures.push(`${path.relative(root, file)} YAML 无法解析：${message(error)}`);
        continue;
      }
      if (!value?.agents || value.schemaVersion !== 2) continue;
      try {
        validateConfig(value);
      } catch (error) {
        failures.push(`${path.relative(root, file)} 不符合 CoreMind Config v2：${message(error)}`);
      }
    }
  }
}

async function yamlFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await yamlFiles(target)));
    else if (/\.ya?ml$/i.test(entry.name)) files.push(target);
  }
  return files;
}

async function requirePath(value, label) {
  requireString(value, label);
  if (typeof value === "string" && !(await exists(path.join(root, value)))) {
    failures.push(`${label} 指向不存在路径：${value}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") failures.push(`${label} 必须是非空字符串`);
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) failures.push(`${label} 应为 ${JSON.stringify(expected)}`);
}

function requireOneOf(actual, expected, label) {
  if (!expected.includes(actual)) {
    failures.push(`${label} 必须是 ${expected.join("、")} 之一，实际为 ${String(actual)}`);
  }
}

function requireArrayContains(value, expected, label) {
  if (!Array.isArray(value) || !value.includes(expected))
    failures.push(`${label} 必须包含 ${expected}`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
