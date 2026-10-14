import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as releaseArtifacts from "./release-artifacts.mjs";
import {
  executeProbe,
  fingerprintTree,
  freezePairedPlan,
  runPairedEvaluation,
  summarizePairedReport,
} from "./run-paired-evaluation.mjs";

interface Cell {
  id: string;
  caseId: string;
  armId: string;
  repetition: number;
}

const temporaryRoots: string[] = [];
const processRecords: string[] = [];
let probeOrdinal = 0;

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const record of processRecords.splice(0)) {
    if (!existsSync(record)) continue;
    const pids = JSON.parse(readFileSync(record, "utf8")) as Record<string, number>;
    for (const pid of Object.values(pids)) terminateOwnedProcess(pid);
  }
  for (const root of temporaryRoots.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(tmpdir()) ||
      !path.basename(root).startsWith("coremind-paired-evaluation-")
    ) {
      throw new Error("拒绝清理评测临时目录之外的路径");
    }
    await rm(root, { recursive: true, force: true });
  }
});

describe("双版本配对评测", () => {
  it("多路完整读取保持冻结树金样，并检测非首批文件的字节变化", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, "nested"));
    for (let index = 0; index < 17; index++) {
      await writeFile(
        path.join(root, index % 2 ? "nested" : "", `file-${String(index).padStart(2, "0")}.txt`),
        `文件${index}\n`,
        "utf8",
      );
    }
    const golden = "f65ce00ab3db577de0cb01ab8ab13bdcbf2d477c20594f74f8465915eca3a327";
    expect(await fingerprintTree(root)).toBe(golden);
    expect(await fingerprintTree(root)).toBe(golden);
    await writeFile(path.join(root, "file-16.txt"), "文件已变化\n", "utf8");
    expect(await fingerprintTree(root)).not.toBe(golden);
  });

  it("一路失败后等待其他读取收敛，再抛出原始原因", async () => {
    const root = await temporaryRoot();
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeFile(path.join(root, `file-${index}.txt`), "asset", "utf8"),
      ),
    );
    const cause = new Error("读取失败的原始原因");
    let release!: () => void;
    let notifyStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const original = releaseArtifacts.createArtifactRecords;
    const lanes: ReturnType<typeof original>[] = [];
    const spy = vi
      .spyOn(releaseArtifacts, "createArtifactRecords")
      .mockImplementation((directory, files) => {
        const lane = (async () => {
          if (path.basename(files[0]) === "file-0.txt") throw cause;
          if (path.basename(files[0]) === "file-1.txt") {
            notifyStarted();
            await blocked;
          }
          return original(directory, files);
        })();
        lanes.push(lane);
        return lane;
      });
    let settled = false;
    let operation: Promise<{ error: unknown }> | undefined;
    try {
      operation = fingerprintTree(root).then(
        () => {
          settled = true;
          return { error: undefined };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      await Promise.race([started, operation]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(spy).toHaveBeenCalledTimes(8);
      expect(settled).toBe(false);
      release();
      expect((await operation).error).toBe(cause);
    } finally {
      release();
      await Promise.allSettled(lanes);
      await operation;
      spy.mockRestore();
    }
  });

  it("冻结完整两场景、两臂、三次计划，并在全部配对间交替 AB/BA", async () => {
    const plan = freezePairedPlan(planInput(await temporaryRoot()));

    expect(plan.cells.map((cell: Cell) => cell.id)).toEqual([
      "typescript-defect:1:baseline",
      "typescript-defect:1:candidate",
      "typescript-defect:2:candidate",
      "typescript-defect:2:baseline",
      "typescript-defect:3:baseline",
      "typescript-defect:3:candidate",
      "python-defect:1:candidate",
      "python-defect:1:baseline",
      "python-defect:2:baseline",
      "python-defect:2:candidate",
      "python-defect:3:candidate",
      "python-defect:3:baseline",
    ]);
  });

  it("拒绝缩减、重复场景及不完整制品身份", async () => {
    const input = planInput(await temporaryRoot());

    for (const invalid of [
      { ...input, arms: input.arms.slice(0, 1) },
      { ...input, cases: ["typescript-defect"] },
      { ...input, cases: ["typescript-defect", "typescript-defect"] },
      { ...input, repetitions: 2 },
      { ...input, arms: [{ ...input.arms[0], manifestSha256: "missing" }, input.arms[1]] },
    ]) {
      expect(() => freezePairedPlan(invalid)).toThrow();
    }
  });

  it("只汇总完整配对，并把未观测费用保留为不可用", async () => {
    const plan = freezePairedPlan(planInput(await temporaryRoot()));
    const summary = summarizePairedReport(plan, successfulRows(plan.cells));

    expect(summary).toMatchObject({
      complete: true,
      qualified: true,
      plannedCells: 12,
      completedCells: 12,
      failedCells: 0,
      errors: [],
    });
    expect(summary.pairs).toHaveLength(6);
    expect(summary.metrics.runtimeMs).toMatchObject({
      pairedCount: 6,
      medianDelta: -50,
      medianPercentChange: -50,
      conclusion: "candidate_lower",
    });
    expect(summary.metrics.costUsd).toMatchObject({
      pairedCount: 0,
      medianDelta: null,
      medianPercentChange: null,
      conclusion: "unavailable",
    });
  });

  it("缺格、重复和错场景、臂、次数或格子身份均不能合格", async () => {
    const plan = freezePairedPlan(planInput(await temporaryRoot()));
    const rows = successfulRows(plan.cells);
    const invalidResults = [
      rows.slice(1),
      [...rows, rows[0]],
      ...[
        { cellId: "unknown-cell" },
        { caseId: "python-defect" },
        { armId: "candidate" },
        { repetition: 2 },
      ].map((change) => [{ ...rows[0], ...change }, ...rows.slice(1)]),
    ];

    for (const results of invalidResults) {
      const summary = summarizePairedReport(plan, results);
      expect(summary.complete).toBe(false);
      expect(summary.qualified).toBe(false);
      expect(summary.errors.length).toBeGreaterThan(0);
    }
  });

  it("失败行的占位零不参与性能比较，安全失败否决合格", async () => {
    const plan = freezePairedPlan(planInput(await temporaryRoot()));
    const failedCandidates = successfulRows(plan.cells).map((row) =>
      row.armId === "candidate"
        ? {
            ...row,
            status: "failed",
            qualityPassed: false,
            metrics: { ...row.metrics, runtimeMs: 0 },
            errors: ["fixture_failed"],
          }
        : row,
    );
    const failed = summarizePairedReport(plan, failedCandidates);
    expect(failed.qualified).toBe(false);
    expect(failed.failedCells).toBe(6);
    expect(failed.metrics.runtimeMs).toMatchObject({
      pairedCount: 0,
      medianDelta: null,
      conclusion: "unavailable",
    });

    const unsafe = successfulRows(plan.cells);
    unsafe[1] = { ...unsafe[1], safetyPassed: false };
    const vetoed = summarizePairedReport(plan, unsafe);
    expect(vetoed.qualified).toBe(false);
    expect(vetoed.pairs[0].eligible).toBe(false);
    expect(vetoed.pairs[0].metrics.runtimeMs).toBeUndefined();
    expect(vetoed.metrics.runtimeMs.pairedCount).toBe(5);
  });

  it("制品准备失败也保留全部计划格子的失败终态和报告", async () => {
    const input = planInput(await temporaryRoot());
    const report = await runPairedEvaluation(input, { timeoutMs: 1_000 });

    expect(report.results).toHaveLength(12);
    expect(report.results.map((row: { cellId: string }) => row.cellId)).toEqual(
      report.plan.cells.map((cell: Cell) => cell.id),
    );
    expect(report.results.every((row: { status: string }) => row.status === "failed")).toBe(true);
    expect(report.summary.qualified).toBe(false);
    const persistedPlan = JSON.parse(
      await readFile(path.join(input.outputDirectory, "plan.json"), "utf8"),
    );
    const persistedRows = (
      await readFile(path.join(input.outputDirectory, "results.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persistedPlan.cells).toHaveLength(12);
    expect(persistedRows).toHaveLength(12);
    expect(
      JSON.parse(await readFile(path.join(input.outputDirectory, "report.json"), "utf8")),
    ).toMatchObject({ summary: { qualified: false } });
  });

  it.each([
    ["registry", "不是本臂本地包"],
    ["integrity", "安装锁完整性不一致"],
  ] as const)("真实准备链拒绝同版本的%s错误锁，完整保留十二格", async (mode, reason) => {
    const root = await temporaryRoot();
    const input = await completeBundleInput(root);
    const fakeNpm = await writeFakeNpm(root, mode);
    vi.stubEnv("npm_execpath", fakeNpm.scriptPath);

    const report = await runPairedEvaluation(input);

    expect(JSON.parse(await readFile(fakeNpm.markerPath, "utf8"))).toMatchObject({
      mode,
      version: "1.0.1",
      tarballs: 8,
    });
    await expectFailedCells(report, reason);
  });

  it("真实制品同长度改动在安装前被摘要拒绝，完整保留十二格", async () => {
    const root = await temporaryRoot();
    const input = await completeBundleInput(root);
    const fakeNpm = await writeFakeNpm(root, "registry");
    vi.stubEnv("npm_execpath", fakeNpm.scriptPath);
    const artifact = path.join(input.arms[0].artifactRoot, "npm/coremind-config-1.0.1.tgz");
    const bytes = await readFile(artifact);
    bytes[0] ^= 1;
    await writeFile(artifact, bytes);

    const report = await runPairedEvaluation(input);

    expect(existsSync(fakeNpm.markerPath)).toBe(false);
    await expectFailedCells(report, "实际 SHA-256 不一致");
  });

  it("真实子进程启动失败生成失败格而不是丢格", async () => {
    const root = await temporaryRoot();
    const request = await probeRequest(root);
    const probePath = await writeProbe(root, "process.stdout.write(JSON.stringify(result));");
    const result = await executeProbe(request, {
      probePath,
      nodePath: path.join(root, "missing-node"),
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ cellId: request.cell.id, status: "failed" });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([
    ["异常退出", "process.stdout.write(JSON.stringify(result)); process.exit(19);"],
    ["非法 JSON", 'process.stdout.write("not-json");'],
    ["错误身份", 'process.stdout.write(JSON.stringify({ ...result, cellId: "foreign" }));'],
  ])("真实探针%s不被误收为成功", async (_name, source) => {
    const root = await temporaryRoot();
    const request = await probeRequest(root);
    const result = await executeProbe(request, {
      probePath: await writeProbe(root, source),
      timeoutMs: 3_000,
    });

    expect(result).toMatchObject({ cellId: request.cell.id, status: "failed" });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("真实夹具复制失败生成有格子身份的失败终态", async () => {
    const root = await temporaryRoot();
    const request = await probeRequest(root);
    request.fixtureRoot = path.join(root, "missing-fixture");
    const result = await executeProbe(request, {
      probePath: await writeProbe(root, COPY_FIXTURE),
      timeoutMs: 3_000,
    });

    expect(result).toMatchObject({ cellId: request.cell.id, status: "failed" });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("每格尊重独立工作区并从原夹具复制，不复用已经修复的副本", async () => {
    const root = await temporaryRoot();
    const input = planInput(root);
    for (const caseId of input.cases) {
      await mkdir(path.join(input.fixtures.root, caseId), { recursive: true });
      await writeFile(
        path.join(input.fixtures.root, caseId, "main.txt"),
        "broken\nuser-owned\n",
        "utf8",
      );
    }
    const plan = freezePairedPlan(input);
    const probePath = await writeProbe(root, COPY_FIXTURE);
    const observedWorkspaces = new Set<string>();
    for (const cell of plan.cells) {
      const request = await probeRequest(root, cell);
      const result = await executeProbe(request, { probePath, timeoutMs: 3_000 });
      expect(result.status).toBe("succeeded");
      expect(result.evidence.before).toBe("broken\nuser-owned\n");
      expect(path.resolve(result.evidence.workspace)).toBe(path.resolve(request.workspace));
      observedWorkspaces.add(result.evidence.workspace);
      expect(await readFile(path.join(request.workspace, "main.txt"), "utf8")).toBe("fixed\n");
    }
    expect(observedWorkspaces.size).toBe(12);
    for (const caseId of input.cases) {
      expect(await readFile(path.join(input.fixtures.root, caseId, "main.txt"), "utf8")).toBe(
        "broken\nuser-owned\n",
      );
    }
  }, 15_000);

  it("超时后真实 wrapper 和孙进程均已退出，再返回失败格", async () => {
    const root = await temporaryRoot();
    const request = await probeRequest(root);
    const processRecord = path.join(root, "owned-processes.json");
    processRecords.push(processRecord);
    const probePath = await writeProbe(
      root,
      `
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "inherit",
        windowsHide: true,
      });
      await writeFile(${JSON.stringify(processRecord)}, JSON.stringify({
        parent: process.pid,
        child: child.pid,
      }), "utf8");
      setInterval(() => {}, 1000);
    `,
    );
    const result = await executeProbe(request, { probePath, timeoutMs: 2_000 });

    expect(result).toMatchObject({ cellId: request.cell.id, status: "failed" });
    expect(result.errors.join("\n")).toMatch(/timeout|timed.out|超时|超过/iu);
    expect(existsSync(processRecord)).toBe(true);
    const pids = Object.values(JSON.parse(await readFile(processRecord, "utf8"))) as number[];
    expect(pids).toHaveLength(2);
    const deadline = performance.now() + 1_000;
    while (pids.some(isProcessAlive) && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pids.map(isProcessAlive)).toEqual([false, false]);
  }, 10_000);
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(path.resolve(tmpdir()), "coremind-paired-evaluation-"));
  temporaryRoots.push(root);
  return root;
}

function planInput(root: string) {
  // 这里只固定计划形状；成功安装的真实制品身份由整合验收核对。
  return {
    schemaVersion: 1,
    arms: [
      {
        id: "baseline",
        artifactRoot: path.join(root, "baseline"),
        manifestSha256: "a".repeat(64),
        commit: "b".repeat(40),
      },
      {
        id: "candidate",
        artifactRoot: path.join(root, "candidate"),
        manifestSha256: "c".repeat(64),
        commit: "d".repeat(40),
      },
    ],
    fixtures: { root: path.join(root, "fixtures"), sha256: "e".repeat(64) },
    cases: ["typescript-defect", "python-defect"],
    repetitions: 3,
    outputDirectory: path.join(root, "report"),
  };
}

async function completeBundleInput(root: string) {
  const input = planInput(root);
  await mkdir(input.fixtures.root);
  input.fixtures.sha256 = await fingerprintTree(input.fixtures.root);
  const entries = [
    ...NPM_PACKAGE_NAMES.map((name) => ({ kind: "npm", name, file: `npm/${name}-1.0.1.tgz` })),
    { kind: "python", name: "coremind-ai", file: "python/coremind_ai-1.0.1-py3-none-any.whl" },
    { kind: "source", name: "coremind-source", file: "source/coremind-1.0.1.zip" },
  ];
  for (const arm of input.arms) {
    const artifacts = [];
    for (const entry of entries) {
      const file = path.join(arm.artifactRoot, entry.file);
      const bytes = Buffer.from(`synthetic:${entry.name}`, "utf8");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      artifacts.push({
        path: entry.file,
        kind: entry.kind,
        name: entry.name,
        version: "1.0.1",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const manifest = JSON.stringify({
      schemaVersion: 1,
      version: "1.0.1",
      npmDistTag: "latest",
      commit: arm.commit,
      artifacts,
    });
    await writeFile(path.join(arm.artifactRoot, "release-manifest.json"), manifest, "utf8");
    arm.manifestSha256 = createHash("sha256").update(manifest, "utf8").digest("hex");
  }
  return input;
}

async function writeFakeNpm(root: string, mode: "registry" | "integrity") {
  const scriptPath = path.join(root, "fake-npm-cli.mjs");
  const markerPath = path.join(root, "fake-npm-called.json");
  // 合成归档只验证字节身份；此夹具仅写坏锁，不安装包或访问网络。
  await writeFile(
    scriptPath,
    `
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const tarballs = process.argv.slice(2).filter((arg) => arg.endsWith(".tgz"));
const packages = {};
for (const tarball of tarballs) {
  const name = path.basename(tarball).replace(/-1\\.0\\.1\\.tgz$/u, "");
  packages["node_modules/" + name] = {
    version: "1.0.1",
    resolved: pathToFileURL(tarball).href,
    integrity: "sha512-" + createHash("sha512").update(await readFile(tarball)).digest("base64"),
  };
}
const bad = packages["node_modules/coremind-ai"];
if (${JSON.stringify(mode)} === "registry") {
  bad.resolved = "https://registry.invalid/coremind-ai/-/coremind-ai-1.0.1.tgz";
} else {
  bad.integrity = "sha512-" + Buffer.alloc(64).toString("base64");
}
await writeFile("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages }), "utf8");
await writeFile(${JSON.stringify(markerPath)}, JSON.stringify({
  mode: ${JSON.stringify(mode)}, version: bad.version, tarballs: tarballs.length,
}), "utf8");
`,
    "utf8",
  );
  return { scriptPath, markerPath };
}

async function expectFailedCells(
  report: Awaited<ReturnType<typeof runPairedEvaluation>>,
  reason: string,
) {
  expect(report.summary.qualified).toBe(false);
  expect(report.summary.errors.join("\n")).toContain(reason);
  expect(report.results).toHaveLength(12);
  expect(report.results.map((row: { cellId: string }) => row.cellId)).toEqual(
    report.plan.cells.map((cell: Cell) => cell.id),
  );
  expect(report.results.every((row: { status: string }) => row.status === "failed")).toBe(true);
  const rows = (await readFile(path.join(report.plan.outputDirectory, "results.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows).toHaveLength(12);
  expect(rows.every((row: { errors: string[] }) => row.errors.join("\n").includes(reason))).toBe(
    true,
  );
}

function successfulRows(cells: Cell[]) {
  return cells.map((cell) => ({
    schemaVersion: 1,
    cellId: cell.id,
    caseId: cell.caseId,
    armId: cell.armId,
    repetition: cell.repetition,
    status: "succeeded",
    qualityPassed: true,
    safetyPassed: true,
    metrics: { runtimeMs: cell.armId === "baseline" ? 100 : 50, costUsd: null },
    grading: {},
    evidence: { fixtureKind: "synthetic" },
    errors: [] as string[],
  }));
}

async function probeRequest(
  root: string,
  cell: Cell = {
    id: "typescript-defect:1:baseline",
    caseId: "typescript-defect",
    armId: "baseline",
    repetition: 1,
  },
) {
  const workspace = path.join(root, "workspaces", cell.id.replaceAll(":", "-"));
  await mkdir(workspace, { recursive: true });
  return {
    schemaVersion: 1,
    cell,
    arm: {
      version: "1.0.1",
      sdkEntry: path.join(root, "sdk.mjs"),
      cliEntry: path.join(root, "cli.mjs"),
      workerEntry: path.join(root, "worker.mjs"),
    },
    fixtureRoot: path.join(root, "fixtures"),
    workspace,
  };
}

async function writeProbe(root: string, source: string): Promise<string> {
  const probePath = path.join(root, `probe-${probeOrdinal++}.mjs`);
  await writeFile(probePath, `${PROBE_INPUT}\n${source}\n`, "utf8");
  return probePath;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateOwnedProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1 || pid === process.pid || !isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 1_000,
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 只回收该夹具记录的进程；可能已由协调器完成清理。
    }
  }
}

const NPM_PACKAGE_NAMES = [
  "coremind-config",
  "coremind-protocol",
  "coremind-tools",
  "coremind-templates",
  "coremind-runtime",
  "coremind-ai",
  "coremind-worker",
  "coremind-cli",
];

const PROBE_INPUT = `
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
let text = "";
for await (const chunk of process.stdin) text += chunk.toString("utf8");
const input = JSON.parse(text);
const result = {
  schemaVersion: 1,
  cellId: input.cell.id,
  caseId: input.cell.caseId,
  armId: input.cell.armId,
  repetition: input.cell.repetition,
  status: "succeeded",
  qualityPassed: true,
  safetyPassed: true,
  metrics: { runtimeMs: 10, costUsd: null },
  grading: {},
  evidence: { fixtureKind: "synthetic" },
  errors: [],
};
`;

const COPY_FIXTURE = `
await cp(path.join(input.fixtureRoot, input.cell.caseId), process.cwd(), { recursive: true });
const before = await readFile("main.txt", "utf8");
await writeFile("main.txt", "fixed\\n", "utf8");
result.evidence = { fixtureKind: "synthetic", before, workspace: process.cwd() };
process.stdout.write(JSON.stringify(result));
`;
