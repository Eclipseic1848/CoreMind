import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coremind-npm-artifacts-"));
try {
  const packages = await publicPackages(repositoryRoot);
  const tarballs = [];
  for (const item of packages) {
    const result = runNpm(
      ["pack", "--workspace", item.name, "--pack-destination", temporaryRoot, "--json"],
      repositoryRoot,
      false,
    );
    const payload = JSON.parse(result.stdout);
    const filename = payload[0]?.filename;
    if (typeof filename !== "string") throw new Error(`${item.name} 未生成 npm tarball`);
    const tarball = path.join(temporaryRoot, filename);
    tarballs.push(tarball);

    runNode([publintCli, "run", tarball, "--strict"], repositoryRoot);
    runNode(
      [attwCli, tarball, "--profile", "esm-only", "--no-emoji", "--no-color"],
      repositoryRoot,
    );
    console.log(`npm tarball 检查通过：${item.name}`);
  }

  const installRoot = path.join(temporaryRoot, "clean-install");
  await mkdir(installRoot);
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: "coremind-clean-install", private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
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

function runNode(args, cwd) {
  return run(process.execPath, args, cwd, false);
}

function run(command, args, cwd, shell, echo = true) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
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
