import { describe, expect, it } from "vitest";
import { evaluateReleaseMetadata, normalizePythonVersion } from "./release-preflight.mjs";

describe("发布元数据预检", () => {
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
