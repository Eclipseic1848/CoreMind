import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkLinuxDependencies,
  cleanupBwrapMountPoints,
  getDefaultWritePaths,
  hasRipgrepSync,
  wrapCommandWithSandboxLinux,
} from "./vendor/linux-sandbox/backend.mjs";

export interface LinuxSandboxConfig {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  credentials: {
    files: Array<{ path: string; mode: "deny" }>;
    envVars: Array<{ name: string; mode: "deny" }>;
  };
  enableWeakerNestedSandbox: false;
  git: { safeDirectories: string[] };
}

let initialization: Promise<string> | undefined;
let helperDirectory: string | undefined;

/** 原生资产在私有目录执行；不依赖安装器保留 wheel 的可执行位。 */
async function initialize(): Promise<string> {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
    throw new Error("当前平台不支持 Linux 安全后端");
  }
  const asset = `bin/${process.arch}/apply-seccomp`;
  const root = new URL("./vendor/linux-sandbox/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8")) as {
    artifacts: Record<string, string>;
  };
  const bytes = await readFile(new URL(asset, root));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== manifest.artifacts[asset]) throw new Error("Linux seccomp 资产摘要不匹配");
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-seccomp-"));
  const helper = path.join(directory, "apply-seccomp");
  try {
    await chmod(directory, 0o700);
    await writeFile(helper, bytes, { mode: 0o700 });
    const dependencies = checkLinuxDependencies({ seccompConfig: { applyPath: helper } });
    if (dependencies.errors.length || dependencies.warnings.length || !hasRipgrepSync()) {
      throw new Error(
        [
          ...dependencies.errors,
          ...dependencies.warnings,
          ...(!hasRipgrepSync() ? ["ripgrep 不可用"] : []),
        ].join("；"),
      );
    }
    helperDirectory = directory;
    return helper;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function initializeLinuxSandboxBackend(): Promise<string> {
  initialization ??= initialize().catch((error) => {
    initialization = undefined;
    throw new Error(
      `Linux sandbox 初始化失败，已拒绝执行 bash：${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  });
  return initialization;
}

/** 只传递已审查的断网配置，不向低层开放代理、桥接或弱化选项。 */
export async function wrapLinuxSandboxCommand(
  command: string,
  config: LinuxSandboxConfig,
  signal?: AbortSignal,
  commandId?: string,
): Promise<{ argv: string[] }> {
  if (config.network.allowedDomains.length || config.enableWeakerNestedSandbox !== false) {
    throw new Error("Linux 后端仅支持严格断网模式");
  }
  signal?.throwIfAborted();
  const helper = await initializeLinuxSandboxBackend();
  signal?.throwIfAborted();
  const wrapped = await wrapCommandWithSandboxLinux({
    command,
    commandId,
    needsNetworkRestriction: true,
    readConfig: {
      denyOnly: [
        ...new Set([
          ...config.filesystem.denyRead,
          ...config.credentials.files.map((file) => file.path),
        ]),
      ],
      allowWithinDeny: [],
    },
    writeConfig: {
      allowOnly: [...getDefaultWritePaths(), ...config.filesystem.allowWrite],
      denyWithinAllow: config.filesystem.denyWrite,
    },
    unsetEnvVars: config.credentials.envVars.map((entry) => entry.name),
    enableWeakerNestedSandbox: false,
    allowAllUnixSockets: false,
    binShell: "/bin/bash",
    gitSafeDirectories: config.git.safeDirectories,
    seccompConfig: { applyPath: helper },
    abortSignal: signal,
  });
  return { argv: ["/bin/bash", "-c", wrapped] };
}

export function cleanupLinuxSandboxCommand(): void {
  cleanupBwrapMountPoints();
}

export async function shutdownLinuxSandboxBackend(): Promise<void> {
  await initialization?.catch(() => {});
  cleanupBwrapMountPoints({ force: true });
  initialization = undefined;
  const directory = helperDirectory;
  helperDirectory = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
}
