import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizePythonVersion,
  synchronizeReleaseVersion,
  validateReleaseVersion,
} from "./release-version.mjs";

describe("统一发布版本", () => {
  it("把 npm 预发布版本映射为 PEP 440", () => {
    expect(normalizePythonVersion("0.2.0-alpha.3")).toBe("0.2.0a3");
    expect(normalizePythonVersion("0.2.0-beta.4")).toBe("0.2.0b4");
    expect(normalizePythonVersion("0.2.0-rc.1")).toBe("0.2.0rc1");
    expect(normalizePythonVersion("0.2.0")).toBe("0.2.0");
    expect(() => normalizePythonVersion("0.2.0-preview.1")).toThrow("预发布标识");
  });

  it("同步根版本、公开包、内部依赖和 Python 版本", async () => {
    const root = createFixture();

    const report = await synchronizeReleaseVersion(root, "0.2.0-rc.1");

    expect(report.npmPackages).toBe(2);
    expect(readJson(path.join(root, "package.json")).version).toBe("0.2.0-rc.1");
    const facade = readJson(path.join(root, "packages", "facade", "package.json"));
    expect(facade.version).toBe("0.2.0-rc.1");
    expect(facade.dependencies["coremind-base"]).toBe("0.2.0-rc.1");
    expect(readFileSync(path.join(root, "python", "pyproject.toml"), "utf8")).toContain(
      'version = "0.2.0rc1"',
    );
    expect(
      readFileSync(path.join(root, "python", "src", "coremind", "__init__.py"), "utf8"),
    ).toContain('__version__ = "0.2.0rc1"');
    await expect(validateReleaseVersion(root)).resolves.toMatchObject({
      ready: true,
      npmVersion: "0.2.0-rc.1",
      pythonVersion: "0.2.0rc1",
    });
  });

  it("版本不一致时返回明确阻塞项", async () => {
    const root = createFixture();
    const facadePath = path.join(root, "packages", "facade", "package.json");
    const facade = readJson(facadePath);
    facade.version = "0.2.0-beta.1";
    writeFileSync(facadePath, `${JSON.stringify(facade, null, 2)}\n`, "utf8");

    const report = await validateReleaseVersion(root);

    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toContain("facade");
  });
});

function createFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "coremind-release-version-"));
  mkdirSync(path.join(root, "packages", "base"), { recursive: true });
  mkdirSync(path.join(root, "packages", "facade"), { recursive: true });
  mkdirSync(path.join(root, "python", "src", "coremind"), { recursive: true });
  writeJson(path.join(root, "package.json"), {
    name: "root",
    private: true,
    version: "0.2.0-beta.2",
  });
  writeJson(path.join(root, "packages", "base", "package.json"), {
    name: "coremind-base",
    version: "0.2.0-beta.2",
  });
  writeJson(path.join(root, "packages", "facade", "package.json"), {
    name: "coremind-facade",
    version: "0.2.0-beta.2",
    dependencies: { "coremind-base": "0.2.0-beta.2", external: "^1.0.0" },
  });
  writeFileSync(
    path.join(root, "python", "pyproject.toml"),
    '[project]\nname = "coremind-ai"\nversion = "0.2.0b2"\n',
    "utf8",
  );
  writeFileSync(
    path.join(root, "python", "src", "coremind", "__init__.py"),
    '__version__ = "0.2.0b2"\n',
    "utf8",
  );
  return root;
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
