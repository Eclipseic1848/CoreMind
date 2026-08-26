import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { ProcessRunner, ProcessRunnerError } from "./process-runner.js";

export type GitAdapterErrorCode =
  | "git_command_failed"
  | "git_invalid_request"
  | "git_path_outside_workspace";

export class GitAdapterError extends Error {
  constructor(
    readonly code: GitAdapterErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GitAdapterError";
  }
}

export interface GitAdapterOptions {
  cwd: string;
  runner?: ProcessRunner;
  maxOutputBytes?: number;
}

export interface GitDiffOptions {
  path?: string;
  staged?: boolean;
  signal?: AbortSignal;
}

export interface GitLogOptions {
  path?: string;
  limit?: number;
  signal?: AbortSignal;
}

export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

/** 只暴露固定 Git 读命令，不接受任意子命令或任意参数。 */
export class GitAdapter {
  private readonly runner: ProcessRunner;
  private readonly maxOutputBytes: number;

  constructor(private readonly options: GitAdapterOptions) {
    this.runner = options.runner ?? new ProcessRunner();
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
  }

  async status(signal?: AbortSignal): Promise<string> {
    return this.execute(["status", "--short", "--untracked-files=all"], signal);
  }

  async statusEntries(signal?: AbortSignal): Promise<GitStatusEntry[]> {
    const output = await this.execute(["status", "--short", "--untracked-files=all", "-z"], signal);
    return parsePorcelainStatus(output);
  }

  async diff(options: GitDiffOptions = {}): Promise<string> {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--unified=3"];
    if (options.staged) args.push("--cached");
    args.push("--");
    if (options.path !== undefined) args.push(await this.safePath(options.path));
    return this.execute(args, options.signal);
  }

  async log(options: GitLogOptions = {}): Promise<string> {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new GitAdapterError("git_invalid_request", "git_log 的 limit 必须是 1 到 50 的整数");
    }
    const args = ["log", `-n${limit}`, "--date=iso-strict", "--format=%h%x09%ad%x09%s", "--"];
    if (options.path !== undefined) args.push(await this.safePath(options.path));
    return this.execute(args, options.signal);
  }

  private async execute(args: string[], signal?: AbortSignal): Promise<string> {
    try {
      const result = await this.runner.run({
        command: "git",
        args: ["--no-pager", "-c", "color.ui=false", ...args],
        cwd: this.options.cwd,
        env: gitEnvironment(),
        signal,
        maxOutputBytes: this.maxOutputBytes,
      });
      if (result.exitCode !== 0) {
        throw new GitAdapterError(
          "git_command_failed",
          result.stderr.trim() || `Git 命令失败，退出码 ${result.exitCode ?? "unknown"}`,
        );
      }
      return result.stdout;
    } catch (error) {
      if (error instanceof GitAdapterError || error instanceof ProcessRunnerError) throw error;
      throw new GitAdapterError(
        "git_command_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  private async safePath(input: string): Promise<string> {
    if (input.length === 0 || input.includes("\0")) {
      throw new GitAdapterError("git_invalid_request", "Git 路径不能为空或包含空字符");
    }
    const lexicalRoot = path.resolve(this.options.cwd);
    const lexicalTarget = path.resolve(lexicalRoot, input);
    if (isOutside(lexicalRoot, lexicalTarget)) {
      throw new GitAdapterError("git_path_outside_workspace", `Git 路径超出工作区：${input}`);
    }
    const canonicalRoot = await canonicalize(lexicalRoot);
    const canonicalTarget = await canonicalize(lexicalTarget);
    if (isOutside(canonicalRoot, canonicalTarget)) {
      throw new GitAdapterError("git_path_outside_workspace", `Git 路径超出工作区：${input}`);
    }
    const relative = path.relative(canonicalRoot, canonicalTarget) || ".";
    return relative.split(path.sep).join("/");
  }
}

const GitStatusParams = Type.Object({});
const GitDiffParams = Type.Object({
  path: Type.Optional(Type.String({ minLength: 1, description: "工作区内的可选相对路径" })),
  staged: Type.Optional(Type.Boolean({ default: false, description: "是否查看暂存区差异" })),
});
const GitLogParams = Type.Object({
  path: Type.Optional(Type.String({ minLength: 1, description: "工作区内的可选相对路径" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10 })),
});

export function createGitStatusTool(cwd: string): AgentTool<typeof GitStatusParams> {
  return createGitStatusToolWithRunner(cwd);
}

export function createGitStatusToolWithRunner(
  cwd: string,
  runner?: ProcessRunner,
): AgentTool<typeof GitStatusParams> {
  const adapter = new GitAdapter({ cwd, runner });
  return {
    name: "git_status",
    label: "Git 状态",
    description: "读取当前 Git 工作区状态；不暂存、不提交、不修改文件。",
    parameters: GitStatusParams,
    execute: async (_callId, _params, signal) =>
      textResult((await adapter.status(signal)) || "工作区干净"),
  };
}

export function createGitDiffTool(cwd: string): AgentTool<typeof GitDiffParams> {
  return createGitDiffToolWithRunner(cwd);
}

export function createGitDiffToolWithRunner(
  cwd: string,
  runner?: ProcessRunner,
): AgentTool<typeof GitDiffParams> {
  const adapter = new GitAdapter({ cwd, runner });
  return {
    name: "git_diff",
    label: "Git 差异",
    description: "读取工作区或暂存区的 Git diff；不调用外部 diff 程序。",
    parameters: GitDiffParams,
    execute: async (_callId, params, signal) =>
      textResult((await adapter.diff({ ...params, signal })) || "没有可显示的差异"),
  };
}

export function createGitLogTool(cwd: string): AgentTool<typeof GitLogParams> {
  return createGitLogToolWithRunner(cwd);
}

export function createGitLogToolWithRunner(
  cwd: string,
  runner?: ProcessRunner,
): AgentTool<typeof GitLogParams> {
  const adapter = new GitAdapter({ cwd, runner });
  return {
    name: "git_log",
    label: "Git 日志",
    description: "读取最近的 Git 提交记录，最多返回 50 条；不修改仓库。",
    parameters: GitLogParams,
    execute: async (_callId, params, signal) =>
      textResult((await adapter.log({ ...params, signal })) || "没有提交记录"),
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const parts = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < parts.length; index++) {
    const item = parts[index];
    if (!item) continue;
    if (item.length < 4 || item[2] !== " ") {
      throw new GitAdapterError("git_command_failed", "Git status 返回了无法识别的格式");
    }
    const entry: GitStatusEntry = {
      index: item[0] ?? " ",
      worktree: item[1] ?? " ",
      path: item.slice(3),
    };
    if (
      entry.index === "R" ||
      entry.index === "C" ||
      entry.worktree === "R" ||
      entry.worktree === "C"
    ) {
      entry.originalPath = parts[++index];
    }
    entries.push(entry);
  }
  return entries;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ];
  return {
    ...Object.fromEntries(
      names.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])),
    ),
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    NO_COLOR: "1",
  };
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
