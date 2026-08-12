import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_BASELINE_ID,
  capturePhase2Baseline,
  evaluatePhase2Baseline,
  REFERENCE_BASELINE_ID,
  resolveActiveBaselineId,
  updatePhase2Baseline,
} from "./phase2-baseline.mjs";

describe("0.3.0 二期基线门禁", () => {
  it("公开 seam、依赖、验收和覆盖率保持一致时通过", () => {
    const baseline = fixture();

    expect(evaluatePhase2Baseline(baseline, structuredClone(baseline))).toEqual({
      ready: true,
      blockers: [],
    });
  });

  it("公开类型或 Schema 漂移时给出可定位阻断", () => {
    const baseline = fixture();
    const actual = structuredClone(baseline);
    actual.publicContracts.apiReports["coremind-runtime"] = "changed";
    actual.publicContracts.schemas.config = "changed";

    const result = evaluatePhase2Baseline(baseline, actual);

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "publicContracts.apiReports.coremind-runtime 与冻结基线不一致",
        "publicContracts.schemas.config 与冻结基线不一致",
      ]),
    );
  });

  it("依赖版本、验收 Case 或覆盖率底线变化时阻止", () => {
    const baseline = fixture();
    const actual = structuredClone(baseline);
    actual.dependencies.installed["runtime-core"] = ["0.83.0", "0.84.1"];
    actual.acceptance.caseIds = ["P01"];
    actual.quality.coverage.totals.branches = 62;

    const result = evaluatePhase2Baseline(baseline, actual);

    expect(result.ready).toBe(false);
    expect(result.blockers.join("\n")).toContain("dependencies.installed.runtime-core");
    expect(result.blockers.join("\n")).toContain("acceptance.caseIds");
    expect(result.blockers.join("\n")).toContain("quality.coverage.totals.branches");
  });

  it("时间戳和采集平台属于证据元数据，不造成合同误报", () => {
    const baseline = fixture();
    const actual = structuredClone(baseline);
    actual.baseline.developmentCommit = "new-development-commit";
    actual.evidence.capturedAt = "2026-08-11T00:00:00.000Z";
    actual.evidence.capturePlatform = "linux";

    expect(evaluatePhase2Baseline(baseline, actual)).toEqual({ ready: true, blockers: [] });
  });

  it("Release Tag 指向或 Release Manifest 漂移时阻止", () => {
    const baseline = fixture();
    const actual = structuredClone(baseline);
    actual.baseline.releaseCommit = "moved-release-tag";
    actual.releaseArtifacts.manifestSha256 = "changed-manifest";

    const result = evaluatePhase2Baseline(baseline, actual);

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        "baseline.releaseCommit 与冻结基线不一致",
        "releaseArtifacts.manifestSha256 与冻结基线不一致",
      ]),
    );
  });

  it("覆盖率提升不会被误判为基线漂移", () => {
    const baseline = fixture();
    const actual = structuredClone(baseline);
    actual.quality.coverage.totals.branches = 64;

    expect(evaluatePhase2Baseline(baseline, actual)).toEqual({ ready: true, blockers: [] });
  });

  it("没有变更原因时拒绝重写冻结基线", async () => {
    await expect(updatePhase2Baseline(process.cwd())).rejects.toThrow(
      "更新冻结基线必须通过 --reason 记录原因",
    );
  });

  it("基线命令先重建正式产物，避免旧 dist 掩盖源码类型漂移", async () => {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(manifest.scripts["baseline:check"]).toBe(
      "npm run build && node scripts/phase2-baseline.mjs",
    );
    expect(manifest.scripts["baseline:update"]).toBe(
      "npm run build && node scripts/phase2-baseline.mjs --update",
    );
  });

  it("通过正式构建产物采集公开 seam、依赖与验收证据", async () => {
    const snapshot = await capturePhase2Baseline(process.cwd(), {
      baselineId: REFERENCE_BASELINE_ID,
      capturedAt: "2026-08-10T00:00:00.000Z",
      capturePlatform: "win32",
    });

    expect(snapshot.baseline).toMatchObject({
      version: "0.2.0-rc.1",
      developmentCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      releaseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(Object.keys(snapshot.publicContracts.apiReports).sort()).toEqual([
      "coremind-ai",
      "coremind-cli",
      "coremind-config",
      "coremind-protocol",
      "coremind-runtime",
      "coremind-templates",
      "coremind-tools",
      "coremind-worker",
    ]);
    expect(Object.values(snapshot.publicContracts.apiReports)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{64}$/)]),
    );
    expect(snapshot.publicContracts.schemas).toEqual({
      config: expect.stringMatching(/^[0-9a-f]{64}$/),
      protocol: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(snapshot.acceptance.caseIds).toHaveLength(20);
    expect(snapshot.acceptance.entries).toEqual(
      expect.arrayContaining(["tui", "headless-cli", "typescript-sdk", "python-sdk"]),
    );
    expect(snapshot.acceptance.behaviorCaseIds).toEqual([
      "abort",
      "approval-deny",
      "cold-start",
      "long-output",
      "network-failure",
      "recovery",
    ]);
    expect(snapshot.acceptance.platforms).toEqual(["linux", "windows"]);
    expect(snapshot.quality.codingEvalProfiles).toEqual(["python", "typescript"]);
    expect(snapshot.quality.codingBenchmark).toMatchObject({
      runsPerProfile: 5,
      minimumSuccessfulRuns: 4,
      requiredSafetyRuns: 5,
      comparisonRunStatus: "not-run",
    });
    expect(snapshot.quality.releaseGates.rc).toMatchObject({
      requiredAcceptanceCases: 20,
      requiredTtyPlatforms: 2,
    });
  }, 60_000);

  it("候选快照存在时使用候选，缺省仍使用参考快照", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "coremind-baseline-choice-"));
    expect(resolveActiveBaselineId(root)).toBe(REFERENCE_BASELINE_ID);
    const candidateDirectory = path.join(root, "baselines", CANDIDATE_BASELINE_ID);
    await mkdir(candidateDirectory, { recursive: true });
    await writeFile(path.join(candidateDirectory, "baseline.json"), "{}\n", "utf8");
    expect(resolveActiveBaselineId(root)).toBe(CANDIDATE_BASELINE_ID);
  });
});

function fixture() {
  return {
    schemaVersion: 1,
    baseline: {
      version: "0.2.0-rc.1",
      referenceVersion: "0.2.0-rc.1",
      developmentCommit: "fd80bdb",
      releaseCommit: "34b32b8",
    },
    publicContracts: {
      apiReports: {
        "coremind-config": "config-api",
        "coremind-runtime": "runtime-api",
      },
      schemas: {
        config: "config-schema",
        protocol: "protocol-schema",
      },
    },
    dependencies: {
      installed: {
        "runtime-core": ["0.83.0"],
      },
    },
    acceptance: {
      caseIds: ["P01", "P02"],
      entries: ["tui", "headless-cli", "typescript-sdk", "python-sdk"],
    },
    releaseArtifacts: {
      manifestSha256: "release-manifest",
    },
    quality: {
      coverage: {
        totals: { lines: 72.82, statements: 70.8, functions: 80.32, branches: 63.3 },
      },
      codingEvalProfiles: ["typescript", "python"],
    },
    evidence: {
      capturedAt: "2026-08-10T00:00:00.000Z",
      capturePlatform: "win32",
    },
  };
}
