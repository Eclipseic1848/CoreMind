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
};

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

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
          value = parseStandardSkill(
            id,
            await readBoundedUtf8(standardPath, canonicalSkill, boundaries),
          );
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
  boundaries: readonly (readonly [string, string])[],
): Promise<string> {
  const checkBoundaries = async () => {
    for (const [source, expected] of boundaries) {
      if ((await realpath(source)) !== expected) throw new Error(`技能目录读取期间变化：${source}`);
    }
  };
  await checkBoundaries();
  const canonical = await realpath(file);
  assertWithin(directory, canonical);
  const before = await stat(canonical, { bigint: true });
  if (!before.isFile()) throw new Error(`技能源不是普通文件：${file}`);
  if (before.size > BigInt(MAX_SOURCE_BYTES)) throw new Error(`技能源超过 256 KiB 上限：${file}`);
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
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

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function parseStandardSkill(id: string, content: string): StandardSkill {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) throw new Error(`技能 ${id} 的 SKILL.md frontmatter 无效`);
  const metadata = parseConfigText(match[1]!, `技能 ${id}`);
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(`技能 ${id} 的 frontmatter 必须是对象`);
  }
  const { name, description } = metadata as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof description !== "string" ||
    !description.trim()
  ) {
    throw new Error(`技能 ${id} 的 name 和 description 必须是非空字符串`);
  }
  const body = content.slice(match[0].length);
  return {
    id,
    name,
    description,
    bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
    body,
  };
}
