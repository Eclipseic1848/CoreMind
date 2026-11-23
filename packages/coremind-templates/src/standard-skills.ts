import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseConfigText } from "coremind-config";
import { findSkill } from "./skills.js";

export type StandardSkill = {
  id: string;
  name: string;
  description: string;
  bodySha256: string;
  body: string;
  packageVersion?: string;
  resources?: { path: string; sha256: string; content: string }[];
};

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const RESOURCE_MANIFEST = "coremind.skill.json";

type SkillBoundaries = readonly (readonly [string, string])[];

export function isSkillResourcePath(value: string): boolean {
  const [root, ...segments] = value.split("/");
  return (
    (root === "assets" || root === "references" || root === "scripts") &&
    segments.length > 0 &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/u.test(segment) &&
        !segment.endsWith(".") &&
        !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(segment),
    )
  );
}

export async function readStandardSkillPackage(sourceDir: string, id: string) {
  assertSkillId(id);
  const directory = path.resolve(sourceDir);
  const canonical = await realpath(directory);
  return readPackageAt(id, [[directory, canonical]]);
}

/** 只解析显式选择；旧技能正文顺序与原内置优先规则一致。 */
export async function resolveSelectedSkills(
  ids: readonly string[],
  configDir: string,
): Promise<{
  legacyContents: string[];
  standard: StandardSkill[];
  missing: string[];
  warnings: string[];
}> {
  const result = {
    legacyContents: [] as string[],
    standard: [] as StandardSkill[],
    missing: [] as string[],
    warnings: [] as string[],
  };
  const pending: string[] = [];
  const names = new Map<string, string>();
  const checkSize = () => {
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_RESULT_BYTES) {
      throw new Error("技能解析结果超过 2 MiB 上限");
    }
  };
  for (const id of ids) {
    assertSkillId(id);
    const builtin = findSkill(id);
    if (builtin) {
      result.legacyContents.push(builtin.content);
      names.set(builtin.name, builtin.id);
      checkSize();
    } else {
      pending.push(id);
    }
  }
  if (pending.length === 0) return result;

  const configPath = path.resolve(configDir);
  const canonicalConfig = await realpath(configPath);
  if (!(await stat(canonicalConfig)).isDirectory()) throw new Error("配置目录不是目录");
  const rootPath = path.join(configPath, "skills");
  const canonicalRoot = await canonicalDirectory(rootPath, canonicalConfig);
  if (!canonicalRoot) {
    for (const id of pending) {
      result.missing.push(id);
      checkSize();
    }
    return result;
  }
  const selected = new Map<string, StandardSkill | string | undefined>();
  const standardIds = new Set<string>();
  for (const id of pending) {
    if (!selected.has(id)) {
      const directoryPath = path.join(rootPath, id);
      const canonicalSkill = await canonicalDirectory(directoryPath, canonicalRoot);
      let value: StandardSkill | string | undefined;
      if (canonicalSkill) {
        const standardPath = path.join(directoryPath, "SKILL.md");
        const legacyPath = path.join(directoryPath, "README.md");
        const standardExists = await exists(standardPath);
        const legacyExists = await exists(legacyPath);
        const boundaries = [
          [configPath, canonicalConfig],
          [rootPath, canonicalRoot],
          [directoryPath, canonicalSkill],
        ] as const;
        if (standardExists) {
          if (legacyExists) {
            result.warnings.push(`技能 ${id} 同时有 SKILL.md 和 README.md，使用 SKILL.md`);
          }
          const available =
            MAX_RESULT_BYTES -
            Buffer.byteLength(JSON.stringify(result), "utf8") -
            Number(result.standard.length > 0);
          value = (await readPackageAt(id, boundaries, available)).skill;
        } else if (await exists(path.join(directoryPath, RESOURCE_MANIFEST))) {
          throw new Error(`技能 ${id} 的 ${RESOURCE_MANIFEST} 缺少 SKILL.md`);
        } else if (legacyExists) {
          value = await readBoundedUtf8(legacyPath, canonicalSkill, boundaries);
        }
      }
      selected.set(id, value);
    }
    const value = selected.get(id);
    if (value === undefined) result.missing.push(id);
    else if (typeof value === "string") result.legacyContents.push(value);
    else if (!standardIds.has(id)) {
      const previous = names.get(value.name);
      if (previous && previous !== id) {
        result.warnings.push(`技能 ${previous} 和 ${id} 使用相同名称 ${value.name}，仍按 ID 区分`);
      }
      names.set(value.name, id);
      standardIds.add(id);
      result.standard.push(value);
    }
    checkSize();
  }
  return result;
}

function assertSkillId(id: string): void {
  if (
    typeof id !== "string" ||
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("\0") ||
    /[\\/:]/u.test(id)
  ) {
    throw new Error(`非法技能 ID：${String(id)}`);
  }
}

async function readPackageAt(id: string, boundaries: SkillBoundaries, limit = MAX_RESULT_BYTES) {
  const [sourceDir, directory] = boundaries.at(-1)!;
  const manifestPath = path.join(sourceDir, RESOURCE_MANIFEST);
  const packaged = await exists(manifestPath);
  const original = packaged ? await stat(directory, { bigint: true }) : undefined;
  const read = (file: string) =>
    readBoundedUtf8(
      path.join(packaged ? directory : sourceDir, file),
      directory,
      boundaries,
      packaged,
    );
  const source = await read("SKILL.md");
  const skill = parseStandardSkill(id, source, packaged);
  if (!original) {
    if (await exists(manifestPath)) throw new Error(`技能清单读取期间出现：${manifestPath}`);
    return { skill, source };
  }

  const manifest = await read(RESOURCE_MANIFEST);
  const declaredResources = parseResourceManifest(id, manifest);
  skill.resources = [];
  let size = Buffer.byteLength(JSON.stringify(skill), "utf8");
  for (const resource of declaredResources) {
    const content = await read(resource.path);
    if (createHash("sha256").update(content, "utf8").digest("hex") !== resource.sha256) {
      throw new Error(`技能 ${id} 的资源 SHA-256 不匹配：${resource.path}`);
    }
    const loaded = { ...resource, content };
    size += Buffer.byteLength(JSON.stringify(loaded), "utf8") + Number(skill.resources.length > 0);
    if (size > limit) throw new Error(`技能解析结果超过 2 MiB 上限：${id}/${resource.path}`);
    skill.resources.push(loaded);
  }
  if (size > limit) throw new Error(`技能解析结果超过 2 MiB 上限：${id}`);
  if (!sameIdentity(original, await stat(directory, { bigint: true }))) {
    throw new Error(`技能包读取期间变化：${directory}`);
  }
  return { skill, source, manifest };
}

function parseResourceManifest(id: string, manifest: string): { path: string; sha256: string }[] {
  const label = `技能 ${id} 的 ${RESOURCE_MANIFEST}`;
  let value: unknown;
  try {
    value = JSON.parse(manifest.replace(/^\uFEFF/u, ""));
  } catch (cause) {
    throw new Error(`${label} 必须是有效 JSON`, { cause });
  }
  // JSON.parse 会覆盖重复键，复用配置解析器检查重复声明。
  parseConfigText(manifest, label);
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.resources)
  ) {
    throw new Error(`${label} 必须包含 schemaVersion: 1 和 resources 列表`);
  }
  const paths = new Map<string, string>();
  return value.resources.map((entry: unknown, index) => {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.path !== "string" ||
      !isSkillResourcePath(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`${label} 的 resources[${index}] 路径或 SHA-256 无效`);
    }
    const segments = entry.path.split("/");
    let prefix = "";
    for (const [index, segment] of segments.entries()) {
      const directory = index < segments.length - 1;
      prefix += directory ? `${segment}/` : segment;
      const key = prefix.replace(/\/$/u, "").toLowerCase();
      const previous = paths.get(key);
      if (previous !== undefined && (previous !== prefix || !directory)) {
        throw new Error(`${label} 的资源路径重复或冲突：${entry.path}`);
      }
      paths.set(key, prefix);
    }
    return { path: entry.path, sha256: entry.sha256 };
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalDirectory(
  directory: string,
  boundary: string,
): Promise<string | undefined> {
  if (!(await exists(directory))) return undefined;
  const canonical = await realpath(directory);
  assertWithin(boundary, canonical);
  if (!(await stat(canonical)).isDirectory()) throw new Error(`技能路径不是目录：${directory}`);
  return canonical;
}

function assertWithin(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`技能路径越界：${target}`);
  }
}

async function readBoundedUtf8(
  file: string,
  directory: string,
  boundaries: SkillBoundaries,
  packaged = false,
): Promise<string> {
  const checkBoundaries = async () => {
    for (const [source, expected] of boundaries) {
      if (packaged) await rejectLink(source);
      if ((await realpath(source)) !== expected) throw new Error(`技能目录读取期间变化：${source}`);
    }
    if (packaged) {
      let current = directory;
      for (const segment of path.relative(directory, file).split(path.sep)) {
        current = path.join(current, segment);
        await rejectLink(current);
      }
    }
  };
  await checkBoundaries();
  const canonical = await realpath(file);
  assertWithin(directory, canonical);
  if (packaged && canonical !== file) throw new Error(`技能路径使用文件系统别名：${file}`);
  const before = await stat(canonical, { bigint: true });
  if (!before.isFile()) throw new Error(`技能源不是普通文件：${file}`);
  if (before.size > BigInt(MAX_SOURCE_BYTES)) throw new Error(`技能源超过 256 KiB 上限：${file}`);
  const flags =
    constants.O_RDONLY | constants.O_NONBLOCK | (packaged ? (constants.O_NOFOLLOW ?? 0) : 0);
  const handle = await open(canonical, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`技能源打开期间变化：${file}`);
    }
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SOURCE_BYTES) throw new Error(`技能源超过 256 KiB 上限：${file}`);
    await checkBoundaries();
    if (
      (await realpath(file)) !== canonical ||
      BigInt(length) !== before.size ||
      !sameIdentity(before, await handle.stat({ bigint: true })) ||
      !sameIdentity(before, await stat(canonical, { bigint: true }))
    ) {
      throw new Error(`技能源读取期间变化：${file}`);
    }
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await handle.close();
  }
}

async function rejectLink(file: string): Promise<void> {
  if ((await lstat(file)).isSymbolicLink()) throw new Error(`技能包路径不能是链接：${file}`);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStandardSkill(id: string, content: string, packaged: boolean): StandardSkill {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw new Error(`技能 ${id} 的 SKILL.md frontmatter 无效`);
  const metadata = parseConfigText(match[1]!, `技能 ${id}`);
  if (!isRecord(metadata)) {
    throw new Error(`技能 ${id} 的 frontmatter 必须是对象`);
  }
  const { name, description } = metadata;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof description !== "string" ||
    !description.trim()
  ) {
    throw new Error(`技能 ${id} 的 name 和 description 必须是非空字符串`);
  }
  const body = content.slice(match[0].length);
  const skill: StandardSkill = {
    id,
    name,
    description,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    body,
  };
  if (packaged) {
    const version = isRecord(metadata.metadata) ? metadata.metadata.version : undefined;
    if (typeof version !== "string" || !version || version.trim() !== version) {
      throw new Error(`技能 ${id} 的 metadata.version 必须是非空字符串且没有首尾空白`);
    }
    skill.packageVersion = version;
  }
  return skill;
}
