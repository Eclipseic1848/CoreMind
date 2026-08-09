import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";

export type DiffLimitErrorCode =
  | "diff_complexity_limit"
  | "diff_input_limit"
  | "diff_output_limit"
  | "diff_path_outside_workspace";

export class DiffLimitError extends Error {
  constructor(
    readonly code: DiffLimitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DiffLimitError";
  }
}

export interface UnifiedDiffOptions {
  oldPath?: string;
  newPath?: string;
  context?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  maxEditLength?: number;
}

export interface FileDiffOptions extends UnifiedDiffOptions {
  cwd: string;
  beforePath: string;
  afterPath: string;
}

/** 为 UTF-8 文本生成标准 unified diff，并对输入、复杂度和输出分别限流。 */
export function createUnifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const maxInputBytes = options.maxInputBytes ?? 10 * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  const inputBytes = Buffer.byteLength(before, "utf8") + Buffer.byteLength(after, "utf8");
  if (inputBytes > maxInputBytes) {
    throw new DiffLimitError(
      "diff_input_limit",
      `diff 输入 ${inputBytes} 字节，超过 ${maxInputBytes} 字节上限`,
    );
  }
  const patch = createTwoFilesPatch(
    safeHeader(options.oldPath ?? "before"),
    safeHeader(options.newPath ?? "after"),
    before,
    after,
    undefined,
    undefined,
    {
      context: options.context ?? 3,
      maxEditLength: options.maxEditLength ?? 50_000,
    },
  );
  if (patch === undefined) {
    throw new DiffLimitError("diff_complexity_limit", "diff 编辑距离超过计算上限");
  }
  const outputBytes = Buffer.byteLength(patch, "utf8");
  if (outputBytes > maxOutputBytes) {
    throw new DiffLimitError(
      "diff_output_limit",
      `diff 输出 ${outputBytes} 字节，超过 ${maxOutputBytes} 字节上限`,
    );
  }
  return patch;
}

/** 对两个工作区普通文件使用同一 diff 实现；路径解析包含目录链接逃逸检查。 */
export async function diffFiles(options: FileDiffOptions): Promise<string> {
  const beforeFile = await safeWorkspaceFile(options.cwd, options.beforePath);
  const afterFile = await safeWorkspaceFile(options.cwd, options.afterPath);
  const [before, after] = await Promise.all([readFile(beforeFile), readFile(afterFile)]);
  const maxInputBytes = options.maxInputBytes ?? 10 * 1024 * 1024;
  if (before.byteLength + after.byteLength > maxInputBytes) {
    throw new DiffLimitError("diff_input_limit", `文件总大小超过 ${maxInputBytes} 字节上限`);
  }
  return createUnifiedDiff(before.toString("utf8"), after.toString("utf8"), {
    ...options,
    oldPath: options.oldPath ?? options.beforePath,
    newPath: options.newPath ?? options.afterPath,
    maxInputBytes,
  });
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n\t]/g, "_");
}

async function safeWorkspaceFile(cwd: string, input: string): Promise<string> {
  if (input.length === 0 || input.includes("\0")) {
    throw new DiffLimitError("diff_path_outside_workspace", "diff 文件路径非法");
  }
  const lexicalRoot = path.resolve(cwd);
  const lexicalTarget = path.resolve(lexicalRoot, input);
  if (isOutside(lexicalRoot, lexicalTarget)) {
    throw new DiffLimitError("diff_path_outside_workspace", `diff 文件超出工作区：${input}`);
  }
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalize(lexicalRoot),
    canonicalize(lexicalTarget),
  ]);
  if (isOutside(canonicalRoot, canonicalTarget)) {
    throw new DiffLimitError("diff_path_outside_workspace", `diff 文件超出工作区：${input}`);
  }
  return canonicalTarget;
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function canonicalize(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return current;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(input);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
