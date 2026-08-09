import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type BashOperations, createBashTool } from "@earendil-works/pi-coding-agent";
import { ProcessRunner, ProcessRunnerError } from "./process-runner.js";

export interface LinuxSandboxedBashOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

let sandboxInitialization: Promise<void> | undefined;

/** Linux bash 使用真实 OS 隔离；初始化或依赖缺失时失败关闭，不回退到宿主 shell。 */
export function createLinuxSandboxedBashTool(options: LinuxSandboxedBashOptions): AgentTool {
  const env = options.env ?? process.env;
  const operations: BashOperations = {
    exec: async (command, cwd, execution) => {
      await ensureSandboxInitialized();
      const tempDirectory = path.join(cwd, ".coremind", "tmp");
      await mkdir(tempDirectory, { recursive: true });
      const commandId = randomUUID();
      const wrapped = await SandboxManager.wrapWithSandboxArgv(
        command,
        "/bin/bash",
        buildLinuxSandboxConfig(cwd, env),
        execution.signal,
        cwd,
        { commandId, commandText: command },
      );
      try {
        return await spawnSandboxed(
          wrapped.argv,
          cwd,
          {
            ...sanitizeEnvironment(env),
            PATH: env.PATH ?? process.env.PATH,
            TMPDIR: tempDirectory,
          },
          execution,
        );
      } finally {
        SandboxManager.cleanupAfterCommand();
      }
    },
  };
  const tool = createBashTool(options.cwd, {
    operations,
    exposeSessionEnvironment: false,
  });
  tool.executionMode = "sequential";
  // 命令工具包带有自己的工具类型副本，结构化执行协议保持兼容。
  return tool as unknown as AgentTool;
}

/** 默认拒绝网络和凭据，只允许写工作区；权限审批与 sandbox 是两条独立防线。 */
export function buildLinuxSandboxConfig(cwd: string, env: NodeJS.ProcessEnv): SandboxRuntimeConfig {
  const workspace = path.resolve(cwd);
  const userHome = homedir();
  const credentialFiles = [
    path.join(workspace, ".env"),
    path.join(workspace, ".npmrc"),
    path.join(userHome, ".ssh"),
    path.join(userHome, ".aws"),
    path.join(userHome, ".azure"),
    path.join(userHome, ".gnupg"),
    path.join(userHome, ".kube"),
    path.join(userHome, ".npmrc"),
    path.join(userHome, ".gitconfig"),
  ];
  const envVars = Object.keys(env)
    .filter(isSensitiveEnvironmentName)
    .sort()
    .map((name) => ({ name, mode: "deny" as const }));

  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: credentialFiles,
      allowWrite: [workspace],
      denyWrite: [
        path.join(workspace, ".env"),
        path.join(workspace, ".git"),
        path.join(workspace, ".coremind", "runs"),
        path.join(workspace, ".coremind", "checkpoints"),
        path.join(workspace, ".coremind", "quality-overrides.jsonl"),
      ],
    },
    credentials: {
      files: credentialFiles.map((file) => ({ path: file, mode: "deny" as const })),
      envVars,
    },
    enableWeakerNestedSandbox: false,
    git: { safeDirectories: [workspace] },
  };
}

export function isSensitiveEnvironmentName(name: string): boolean {
  return /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|DATABASE_URL|CONNECTION_STRING|CREDENTIALS?|AWS_ACCESS_KEY_ID)(?:$|_)/i.test(
    name,
  );
}

async function ensureSandboxInitialized(): Promise<void> {
  sandboxInitialization ??= SandboxManager.initialize(
    {
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      enableWeakerNestedSandbox: false,
    },
    undefined,
    true,
  ).catch((error) => {
    sandboxInitialization = undefined;
    throw new Error(
      `Linux sandbox 初始化失败，已拒绝执行 bash：${error instanceof Error ? error.message : String(error)}`,
    );
  });
  await sandboxInitialization;
}

function sanitizeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !isSensitiveEnvironmentName(name)),
  );
}

async function spawnSandboxed(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: Parameters<BashOperations["exec"]>[2],
): Promise<{ exitCode: number | null }> {
  const executable = argv[0];
  if (!executable) throw new Error("Linux sandbox 未生成可执行命令");
  try {
    const result = await new ProcessRunner().run({
      command: executable,
      args: argv.slice(1),
      cwd,
      env,
      signal: options.signal,
      timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1_000,
      onData: options.onData,
    });
    return { exitCode: result.exitCode };
  } catch (error) {
    if (error instanceof ProcessRunnerError && error.code === "process_aborted") {
      throw new Error("aborted", { cause: error });
    }
    if (error instanceof ProcessRunnerError && error.code === "process_timeout") {
      throw new Error(`timeout:${options.timeout}`, { cause: error });
    }
    throw error;
  }
}
