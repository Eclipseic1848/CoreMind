import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNpmDependencyFamily,
  buildWorkerRuntimeDependencies,
  DEPENDENCY_FAMILY,
  declaredFamilyVersion,
} from "./dependency-family.mjs";

interface NpmNode {
  version?: string;
  dependencies?: Record<string, NpmNode>;
  problems?: string[];
}
function graph(version = "1.2.0"): NpmNode & { dependencies: Record<string, NpmNode> } {
  return { dependencies: Object.fromEntries(DEPENDENCY_FAMILY.map((name) => [name, { version }])) };
}

describe("真实消费者依赖身份", () => {
  it.each(["1.2.0", "1.3.0"])("按当前精确声明核对七个成员：%s", (version) => {
    expect(assertNpmDependencyFamily(graph(version), version)).toMatchObject({
      packages: 7,
      version,
    });
  });
  it("发现深层重复版本，不只检查顶层依赖", () => {
    const value = graph();
    value.dependencies.extra = {
      version: "1.0.0",
      dependencies: {
        [DEPENDENCY_FAMILY[1]!]: { version: "1.3.0" },
      },
    };
    expect(() => assertNpmDependencyFamily(value, "1.2.0")).toThrow(/漂移/u);
  });
  it("拒绝缺成员和 npm problems，不把不完整图称为锁步", () => {
    const missing = graph();
    delete missing.dependencies[DEPENDENCY_FAMILY.at(-1)!];
    expect(() => assertNpmDependencyFamily(missing, "1.2.0")).toThrow(/缺失/u);
    expect(() =>
      assertNpmDependencyFamily({ ...graph(), problems: ["invalid peer"] }, "1.2.0"),
    ).toThrow();
  });
  it("直接依赖只接受同一精确声明，不把范围当消费者保证", () => {
    const declarations = (version: string) => [
      {
        dependencies: Object.fromEntries(
          DEPENDENCY_FAMILY.slice(0, 3).map((name) => [name, version]),
        ),
      },
    ];
    expect(declaredFamilyVersion(declarations("1.2.0"))).toBe("1.2.0");
    expect(() => declaredFamilyVersion(declarations("^1.2.0"))).toThrow(/精确/u);
  });
  it("Worker 核实际 metadata，且只有贡献输出字节的成员标记 bundled", async () => {
    const root = path.resolve(tmpdir());
    const directory = mkdtempSync(path.join(root, "coremind-dependency-identity-"));
    const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
    try {
      const packages: Record<string, { version: string; integrity: string }> = {};
      for (const name of DEPENDENCY_FAMILY) {
        const relative = `node_modules/${name}`;
        mkdirSync(path.join(directory, relative), { recursive: true });
        writeFileSync(
          path.join(directory, relative, "package.json"),
          JSON.stringify({ name, version: "1.2.0" }),
          "utf8",
        );
        packages[relative] = { version: "1.2.0", integrity };
      }
      writeFileSync(
        path.join(directory, "package-lock.json"),
        JSON.stringify({ packages }),
        "utf8",
      );
      const used = DEPENDENCY_FAMILY[1]!;
      const unused = DEPENDENCY_FAMILY.at(-1)!;
      const metafile = {
        outputs: {
          "worker.mjs": {
            inputs: {
              [`node_modules/${used}/dist/index.js`]: { bytesInOutput: 10 },
              [`node_modules/${unused}/dist/index.js`]: { bytesInOutput: 0 },
              [`node_modules/${unused}/node_modules/other/index.js`]: { bytesInOutput: 5 },
            },
          },
        },
      };
      const dependencies = await buildWorkerRuntimeDependencies(directory, metafile, "1.2.0");
      expect(Object.keys(dependencies)).toHaveLength(7);
      expect(dependencies[used]).toEqual({ version: "1.2.0", integrity, bundled: true });
      expect(dependencies[unused]!.bundled).toBe(false);
      writeFileSync(
        path.join(directory, "node_modules", used, "package.json"),
        JSON.stringify({ name: used, version: "1.3.0" }),
        "utf8",
      );
      await expect(buildWorkerRuntimeDependencies(directory, metafile, "1.2.0")).rejects.toThrow(
        /安装身份/u,
      );
    } finally {
      expect(path.dirname(path.resolve(directory))).toBe(root);
      expect(path.basename(directory).startsWith("coremind-dependency-identity-")).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
