import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const semver = require("semver") as {
  valid(version: string): string | null;
  satisfies(version: string, range: string): boolean;
};
const affectedVersions =
  "<=6.4.3 || >=7.0.0 <=7.3.6 || >=8.0.0 <=8.1.5 || >=8.2.0 <=8.2.3 || >=8.3.0 <=8.3.2";

describe("Vite 实际安装依赖安全", () => {
  it.each(["vitest", "vitepress"])("%s 加载的 Vite 已修复且与锁文件一致", (owner) => {
    const ownerManifest = require.resolve(`${owner}/package.json`);
    // 从实际使用方解析，覆盖提升依赖与包内嵌套依赖两条加载路径。
    const viteManifest = createRequire(ownerManifest).resolve("vite/package.json");
    const installed = JSON.parse(readFileSync(viteManifest, "utf8")) as {
      name: string;
      version: string;
    };
    const lock = JSON.parse(
      readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8"),
    ) as {
      packages: Record<string, { version?: string }>;
    };
    const lockPath = path
      .relative(process.cwd(), path.dirname(viteManifest))
      .split(path.sep)
      .join("/");

    expect(installed.name).toBe("vite");
    expect(semver.valid(installed.version), `${owner}: ${viteManifest}`).not.toBeNull();
    expect(lock.packages[lockPath]?.version, `${owner}: ${lockPath}`).toBe(installed.version);
    expect(
      semver.satisfies(installed.version, affectedVersions),
      `${owner} 实际加载 ${lockPath}@${installed.version}，仍处于 Vite 安全公告受影响范围`,
    ).toBe(false);
  });
});
