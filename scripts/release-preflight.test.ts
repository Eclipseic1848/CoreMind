import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateReleaseMetadata,
  inspectRepository,
  normalizePythonVersion,
} from "./release-preflight.mjs";

describe("发布元数据预检", () => {
  it("普通开发检查可以延后当前 Runtime 的 Provider 认证", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-preflight.mjs",
        "--allow-dirty",
        "--defer-provider-certification",
        "--json",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report.ready).toBe(true);
    expect(report.blockers).not.toContain("Provider 认证证据未绑定当前版本与 Runtime 摘要");
    expect(report.warnings).toContain(
      "开发分支已延后当前 Runtime 的 Provider 认证；发布候选必须移除此选项",
    );
  });

  it("环境变量不能绕过严格发布预检", async () => {
    const fixtureRoot = await createUncertifiedRepositoryFixture();
    const original = process.env.COREMIND_DEFER_PROVIDER_CERTIFICATION;
    process.env.COREMIND_DEFER_PROVIDER_CERTIFICATION = "1";
    try {
      const report = await inspectRepository(fixtureRoot, { allowDirty: true });

      expect(report.ready).toBe(false);
      expect(report.blockers).toContain("Provider 认证证据未绑定当前版本与 Runtime 摘要");
    } finally {
      if (original === undefined) delete process.env.COREMIND_DEFER_PROVIDER_CERTIFICATION;
      else process.env.COREMIND_DEFER_PROVIDER_CERTIFICATION = original;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("把 PEP 440 预发布版本转换为 npm 版本", () => {
    expect(normalizePythonVersion("0.2.0a1")).toBe("0.2.0-alpha.1");
    expect(normalizePythonVersion("0.2.0b2")).toBe("0.2.0-beta.2");
    expect(normalizePythonVersion("0.2.0rc3")).toBe("0.2.0-rc.3");
    expect(normalizePythonVersion("0.2.0")).toBe("0.2.0");
  });

  it("只有包版本、许可证、仓库信息、README 和 Python 版本一致时通过", () => {
    const report = evaluateReleaseMetadata({
      packages: [
        {
          name: "coremind-ai",
          version: "0.2.0-beta.1",
          license: "MIT",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          homepage: "https://github.com/Eclipseic1848/CoreMind#readme",
          bugs: "https://github.com/Eclipseic1848/CoreMind/issues",
          readmeExists: true,
        },
        {
          name: "coremind-cli",
          version: "0.2.0-beta.1",
          license: "MIT",
          repository: "https://github.com/Eclipseic1848/CoreMind.git",
          homepage: "https://github.com/Eclipseic1848/CoreMind#readme",
          bugs: "https://github.com/Eclipseic1848/CoreMind/issues",
          readmeExists: true,
        },
      ],
      pythonVersion: "0.2.0b1",
      requiredFilesMissing: [],
      providerMatrixCurrent: true,
      providerCertificationCurrent: true,
    });

    expect(report.ready).toBe(true);
    expect(report.releaseVersion).toBe("0.2.0-beta.1");
    expect(report.blockers).toEqual([]);
  });

  it("把不一致版本和缺失社区文件列为阻塞，而不是静默放行", () => {
    const report = evaluateReleaseMetadata({
      packages: [
        {
          name: "coremind-ai",
          version: "0.2.0-beta.1",
          license: "",
          repository: "",
          homepage: "",
          bugs: "",
          readmeExists: false,
        },
        {
          name: "coremind-cli",
          version: "0.2.0-beta.2",
          license: "MIT",
          repository: "repo",
          homepage: "home",
          bugs: "bugs",
          readmeExists: true,
        },
      ],
      pythonVersion: "0.2.0b1",
      requiredFilesMissing: ["SECURITY.md"],
      providerMatrixCurrent: false,
      providerCertificationCurrent: false,
    });

    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toContain("版本不一致");
    expect(report.blockers.join("\n")).toContain("SECURITY.md");
    expect(report.blockers.join("\n")).toContain("Provider 矩阵");
    expect(report.blockers.join("\n")).toContain("Runtime 摘要");
  });
});

async function createUncertifiedRepositoryFixture() {
  const sourceRoot = process.cwd();
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "coremind-release-preflight-"));
  await cp(path.join(sourceRoot, "package.json"), path.join(fixtureRoot, "package.json"));
  await mkdir(path.join(fixtureRoot, "packages"), { recursive: true });
  for (const entry of await readdir(path.join(sourceRoot, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourcePackage = path.join(sourceRoot, "packages", entry.name);
    const targetPackage = path.join(fixtureRoot, "packages", entry.name);
    await mkdir(targetPackage, { recursive: true });
    await cp(path.join(sourcePackage, "package.json"), path.join(targetPackage, "package.json"));
    await cp(path.join(sourcePackage, "README.md"), path.join(targetPackage, "README.md"));
  }
  await mkdir(path.join(fixtureRoot, "python"), { recursive: true });
  await cp(
    path.join(sourceRoot, "python", "pyproject.toml"),
    path.join(fixtureRoot, "python", "pyproject.toml"),
  );
  await mkdir(path.join(fixtureRoot, "python", "src", "coremind"), { recursive: true });
  await cp(
    path.join(sourceRoot, "python", "src", "coremind", "__init__.py"),
    path.join(fixtureRoot, "python", "src", "coremind", "__init__.py"),
  );
  await mkdir(path.join(fixtureRoot, "docs", "providers"), { recursive: true });
  for (const file of ["certifications.json", "matrix.json"]) {
    await cp(
      path.join(sourceRoot, "docs", "providers", file),
      path.join(fixtureRoot, "docs", "providers", file),
    );
  }
  return fixtureRoot;
}
