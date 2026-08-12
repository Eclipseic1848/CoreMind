import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LOCKSTEP_VERSION = "0.84.1";
const dependencyNames = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;

describe("二期核心依赖锁步合同", () => {
  it("声明和安装树只包含一个精确版本族", async () => {
    const root = process.cwd();
    const manifests = await Promise.all(
      ["packages/coremind-runtime/package.json", "packages/coremind-tools/package.json"].map(
        async (relativePath) =>
          JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as {
            dependencies?: Record<string, string>;
          },
      ),
    );
    const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string }>;
    };

    for (const dependencyName of dependencyNames) {
      const declarations = manifests
        .map((manifest) => manifest.dependencies?.[dependencyName])
        .filter((version): version is string => Boolean(version));
      expect(declarations, dependencyName).not.toHaveLength(0);
      expect(new Set(declarations), dependencyName).toEqual(new Set([LOCKSTEP_VERSION]));

      const suffix = `node_modules/${dependencyName}`;
      const installed = new Set(
        Object.entries(lock.packages ?? {})
          .filter(([packagePath, metadata]) => packagePath.endsWith(suffix) && metadata.version)
          .map(([, metadata]) => metadata.version as string),
      );
      expect(installed, dependencyName).toEqual(new Set([LOCKSTEP_VERSION]));
    }
  });

  it("工具 Adapter 不再依赖跨版本双重强转", async () => {
    const files = await Promise.all(
      [
        "packages/coremind-tools/src/registry.ts",
        "packages/coremind-tools/src/host-shell.ts",
        "packages/coremind-tools/src/linux-sandbox.ts",
      ].map((relativePath) => readFile(path.join(process.cwd(), relativePath), "utf8")),
    );

    expect(files.join("\n")).not.toMatch(/as unknown as AgentTool|bridgeCodingTool/);
  });
});
