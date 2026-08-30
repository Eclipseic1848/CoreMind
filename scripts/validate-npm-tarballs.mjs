import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publintCli = path.join(repositoryRoot, "node_modules", "publint", "src", "cli.js");
const attwCli = path.join(
  repositoryRoot,
  "node_modules",
  "@arethetypeswrong",
  "cli",
  "dist",
  "index.js",
);

const mockServerPath = path.join(
  repositoryRoot,
  "packages",
  "coremind-cli",
  "test",
  "mock-delegation-server.mjs",
);
const mockConfigPath = path.join(
  repositoryRoot,
  "packages",
  "coremind-cli",
  "test",
  "mock-delegation-config.json",
);

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coremind-npm-artifacts-"));
  try {
    const packages = await publicPackages(repositoryRoot);
    const directoryIndex = process.argv.indexOf("--directory");
    const directory = directoryIndex >= 0 ? path.resolve(process.argv[directoryIndex + 1]) : null;
    const tarballs = directory
      ? (await readdir(directory))
          .filter((name) => name.endsWith(".tgz"))
          .map((name) => path.join(directory, name))
      : packTarballs(packages, temporaryRoot);
    if (tarballs.length !== packages.length) {
      throw new Error(`应有 ${packages.length} 个 npm tarball，实际为 ${tarballs.length} 个`);
    }
    for (const tarball of tarballs) {
      runNode([publintCli, "run", tarball, "--strict"], repositoryRoot);
      runNode(
        [attwCli, tarball, "--profile", "esm-only", "--no-emoji", "--no-color"],
        repositoryRoot,
      );
    }

    const installRoot = path.join(temporaryRoot, "clean-install");
    await mkdir(installRoot);
    await writeFile(
      path.join(installRoot, "package.json"),
      `${JSON.stringify({ name: "coremind-clean-install", private: true, type: "module" }, null, 2)}\n`,
      "utf8",
    );
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...tarballs,
      ],
      installRoot,
    );
    const importProgram = `
    const names = ${JSON.stringify(packages.map((item) => item.name))};
    for (const name of names) await import(name);
    console.log(JSON.stringify({ imported: names }));
  `;
    runNode(["--input-type=module", "--eval", importProgram], installRoot);
    runNode(
      [path.join(installRoot, "node_modules", "coremind-cli", "dist", "cli.js"), "--version"],
      installRoot,
    );
    await smokeChildRun(installRoot);
    console.log(`npm 干净安装与 ESM 导入检查通过：${packages.length} 个包`);
  } finally {
    const resolvedTemp = path.resolve(temporaryRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    if (
      resolvedTemp.startsWith(`${resolvedOsTemp}${path.sep}`) &&
      path.basename(resolvedTemp).startsWith("coremind-npm-artifacts-")
    ) {
      await rm(resolvedTemp, { recursive: true, force: true });
    }
  }
}

function packTarballs(packages, outputDirectory) {
  return packages.map((item) => {
    const result = runNpm(
      ["pack", "--workspace", item.name, "--pack-destination", outputDirectory, "--json"],
      repositoryRoot,
      false,
    );
    const filename = JSON.parse(result.stdout)[0]?.filename;
    if (typeof filename !== "string") throw new Error(`${item.name} 未生成 npm tarball`);
    return path.join(outputDirectory, filename);
  });
}

async function smokeChildRun(installRoot) {
  const port = await freePort();
  const server = spawn(process.execPath, [mockServerPath, String(port)], {
    cwd: installRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(server);
    const config = JSON.parse(await readFile(mockConfigPath, "utf8"));
    config.provider.baseUrl = `http://127.0.0.1:${port}/v1`;
    const configPath = path.join(installRoot, "coremind.yaml");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const result = runNode(
      [
        path.join(installRoot, "node_modules", "coremind-cli", "dist", "cli.js"),
        "run",
        configPath,
        "--prompt",
        "完成父任务",
        "--json-events",
      ],
      installRoot,
      { COREMIND_TEST_API_KEY: "candidate-only" },
      false,
    );
    const events = result.stdout
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
    const child = events.find((event) => event.type === "child_run");
    if (child?.status !== "joined" || child?.outcome?.status !== "succeeded") {
      throw new Error("候选 tarball 的 Child Run 冒烟未成功");
    }
    console.log("npm 候选 tarball Child Run 冒烟通过");
  } finally {
    await stopServer(server);
  }
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, "exit", { signal: AbortSignal.timeout(5_000) });
  server.kill();
  try {
    await exited;
  } catch {
    if (server.exitCode !== null || server.signalCode !== null) return;
    const forcedExit = once(server, "exit", { signal: AbortSignal.timeout(2_000) });
    server.kill("SIGKILL");
    await forcedExit;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("无法分配端口")),
      );
    });
  });
}

function waitForServer(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("mock Child Run server 启动超时")), 10_000);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function publicPackages(rootDirectory) {
  const directories = await readdir(path.join(rootDirectory, "packages"), { withFileTypes: true });
  const packages = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const manifestPath = path.join(rootDirectory, "packages", directory.name, "package.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (manifest.private !== true) packages.push({ name: manifest.name });
  }
  return packages;
}

function runNpm(args, cwd, echo = true) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd, false, echo);
  return run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    cwd,
    process.platform === "win32",
    echo,
  );
}

function runNode(args, cwd, environment = {}, echo = true) {
  return run(process.execPath, args, cwd, false, echo, environment);
}

function run(command, args, cwd, shell, echo = true, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...environment, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (echo && result.stdout) process.stdout.write(result.stdout);
  if (echo && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => value?.trim())
      .map((value) => value.trim())
      .join("\n");
    throw new Error(
      `命令失败（${result.status}）：${command} ${args.join(" ")}${detail ? `\n${detail}` : ""}`,
    );
  }
  return result;
}

await main();
