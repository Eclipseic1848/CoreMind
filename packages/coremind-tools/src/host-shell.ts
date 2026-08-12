import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type BashOperations, createBashTool } from "@earendil-works/pi-coding-agent";
import { ProcessRunner, ProcessRunnerError } from "./process-runner.js";

export interface HostBashOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface ShellInvocation {
  command: string;
  args(command: string): string[];
  input?(command: string): string;
}

/** 非 Linux 宿主命令统一走 ProcessRunner；权限层仍在执行前决定是否允许。 */
export function createHostBashTool(options: HostBashOptions): AgentTool {
  const env = options.env ?? process.env;
  const operations: BashOperations = {
    exec: async (command, cwd, execution) => {
      const shell = process.platform === "win32" ? resolveWindowsShell(env) : posixShell();
      try {
        const result = await new ProcessRunner().run({
          command: shell.command,
          args: shell.args(command),
          input: shell.input?.(command),
          cwd,
          env,
          signal: execution.signal,
          timeoutMs: execution.timeout === undefined ? undefined : execution.timeout * 1_000,
          onData: execution.onData,
        });
        return { exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof ProcessRunnerError && error.code === "process_aborted") {
          throw new Error("aborted", { cause: error });
        }
        if (error instanceof ProcessRunnerError && error.code === "process_timeout") {
          throw new Error(`timeout:${execution.timeout}`, { cause: error });
        }
        throw error;
      }
    },
  };
  const tool = createBashTool(options.cwd, {
    operations,
    exposeSessionEnvironment: false,
  });
  tool.executionMode = "sequential";
  return tool;
}

/** 优先寻找 Git 安装目录内的真实 Bash，明确排除 WSL/应用商店中继。 */
export function resolveWindowsShell(
  env: NodeJS.ProcessEnv,
  pathExists: (candidate: string) => boolean = existsSync,
): ShellInvocation {
  const gitBash = findGitBash(env, pathExists);
  if (gitBash) {
    return {
      command: gitBash,
      args: (command) => ["--noprofile", "--norc", "-lc", command],
    };
  }
  return {
    command: "powershell.exe",
    args: (command) => {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        "$OutputEncoding = [Console]::OutputEncoding",
        command,
        "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }",
      ].join("\n");
      return [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ];
    },
  };
}

function findGitBash(
  env: NodeJS.ProcessEnv,
  pathExists: (candidate: string) => boolean,
): string | undefined {
  const candidates = new Set<string>();
  for (const entry of (env.PATH ?? env.Path ?? "").split(path.win32.delimiter)) {
    const directory = entry.replace(/^"|"$/g, "").trim();
    if (!directory) continue;
    if (pathExists(path.win32.join(directory, "git.exe"))) {
      const parent =
        path.win32.basename(directory).toLowerCase() === "cmd"
          ? path.win32.dirname(directory)
          : directory;
      candidates.add(path.win32.join(parent, "bin", "bash.exe"));
    }
    const lowered = directory.toLowerCase();
    if (!lowered.includes("windows\\system32") && !lowered.includes("windowsapps")) {
      candidates.add(path.win32.join(directory, "bash.exe"));
    }
  }
  for (const root of [
    env.ProgramW6432,
    env.ProgramFiles,
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs"),
  ]) {
    if (root) candidates.add(path.win32.join(root, "Git", "bin", "bash.exe"));
  }
  return [...candidates].find((candidate) => pathExists(candidate));
}

function posixShell(): ShellInvocation {
  return { command: "/bin/bash", args: (command) => ["-lc", command] };
}
