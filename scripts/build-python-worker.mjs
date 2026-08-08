import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonPackage = path.join(repositoryRoot, "python", "src", "coremind");
const workerDirectory = path.join(pythonPackage, "_worker");
const workerOutput = path.join(workerDirectory, "coremind-worker.mjs");

await mkdir(workerDirectory, { recursive: true });
await build({
  entryPoints: [path.join(repositoryRoot, "packages", "coremind-worker", "src", "stdio.ts")],
  outfile: workerOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __coremindCreateRequire } from "node:module"; const require = __coremindCreateRequire(import.meta.url);',
  },
});

// 第三方内联文本可能保留空白行缩进；发布前统一清理，保证 Git 格式门禁可重复通过。
const workerBundle = await readFile(workerOutput, "utf8");
await writeFile(workerOutput, workerBundle.replace(/[ \t]+$/gm, ""), "utf8");

await cp(
  path.join(repositoryRoot, "packages", "coremind-templates", "skills"),
  path.join(pythonPackage, "skills"),
  { recursive: true, force: true },
);
