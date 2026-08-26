import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createLinuxSandboxExecutionEnvironment,
  createTrustedHostExecutionEnvironment,
  type ExecutionEnvironment,
} from "./execution-environment.js";
import {
  buildLinuxSandboxConfig,
  ensureLinuxSandboxInitialized,
  sanitizeLinuxSandboxEnvironment,
} from "./linux-sandbox.js";
import { ProcessRunner, probeProcessTreeTermination } from "./process-runner.js";

const linuxProbeByWorkspace = new Map<
  string,
  Promise<{ available: boolean; evidence: readonly string[] }>
>();
let processTreeProbe: ReturnType<typeof probeProcessTreeTermination> | undefined;

/** 按真实平台能力选择当前 Adapter；名称本身不产生任何安全结论。 */
export function createPlatformExecutionEnvironment(input: {
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): ExecutionEnvironment {
  const platform = input.platform ?? process.platform;
  if (platform === "linux") {
    return createLinuxSandboxExecutionEnvironment({
      workspaceRoot: input.workspaceRoot,
      platform,
      probeSandbox: () => cachedLinuxSandboxProbe(input.workspaceRoot, input.env ?? process.env),
      probeProcessControl: () => (processTreeProbe ??= probeProcessTreeTermination()),
    });
  }
  return createTrustedHostExecutionEnvironment({
    workspaceRoot: input.workspaceRoot,
    platform,
    probeProcessControl: () => (processTreeProbe ??= probeProcessTreeTermination()),
  });
}

async function cachedLinuxSandboxProbe(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<{ available: boolean; evidence: readonly string[] }> {
  const root = path.resolve(workspaceRoot);
  const existing = linuxProbeByWorkspace.get(root);
  if (existing) return existing;
  const created = probeLinuxSandbox(root, env).catch((error) => ({
    available: false,
    evidence: [
      `linux-sandbox-probe-error:${error instanceof Error ? error.message : String(error)}`,
    ],
  }));
  linuxProbeByWorkspace.set(root, created);
  return created;
}

async function probeLinuxSandbox(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<{ available: boolean; evidence: readonly string[] }> {
  if (process.platform !== "linux") {
    return { available: false, evidence: ["platform-not-linux"] };
  }
  await ensureLinuxSandboxInitialized();
  const probeEnvironment = {
    ...env,
    COREMIND_SANDBOX_PROBE_SECRET: randomUUID(),
  };
  const outsidePath = path.join(tmpdir(), `coremind-sandbox-probe-${randomUUID()}`);
  const server = createServer((_request, response) => response.end("reachable"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法创建本地网络负向探针");
  const probeScript = buildLinuxSandboxProbeScript(outsidePath, address.port);
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(probeScript)}`;
  const commandId = randomUUID();
  try {
    const wrapped = await SandboxManager.wrapWithSandboxArgv(
      command,
      "/bin/bash",
      buildLinuxSandboxConfig(workspaceRoot, probeEnvironment),
      undefined,
      workspaceRoot,
      { commandId, commandText: "CoreMind Linux sandbox negative probe" },
    );
    const executable = wrapped.argv[0];
    if (!executable) throw new Error("Linux sandbox probe 未生成可执行命令");
    const result = await new ProcessRunner().run({
      command: executable,
      args: wrapped.argv.slice(1),
      cwd: workspaceRoot,
      env: {
        ...sanitizeLinuxSandboxEnvironment(probeEnvironment),
        PATH: env.PATH ?? process.env.PATH,
      },
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    const available = result.exitCode === 0;
    return {
      available,
      evidence: [
        `linux-sandbox:outside-write:${available ? "blocked" : "unverified"}`,
        `linux-sandbox:network:${available ? "blocked" : "unverified"}`,
        `linux-sandbox:credential-env:${available ? "hidden" : "unverified"}`,
      ],
    };
  } finally {
    SandboxManager.cleanupAfterCommand();
    await rm(outsidePath, { force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 生成交给 Node 执行的 Linux sandbox 负向探针脚本。 */
export function buildLinuxSandboxProbeScript(outsidePath: string, port: number): string {
  return [
    "const fs = require('node:fs')",
    `let outsideBlocked = false; try { fs.writeFileSync(${JSON.stringify(outsidePath)}, 'x') } catch { outsideBlocked = true }`,
    "const credentialHidden = process.env.COREMIND_SANDBOX_PROBE_SECRET === undefined",
    `fetch(${JSON.stringify(`http://127.0.0.1:${port}`)})`,
    ".then(() => process.exit(3))",
    ".catch(() => process.exit(outsideBlocked && credentialHidden ? 0 : 4))",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
