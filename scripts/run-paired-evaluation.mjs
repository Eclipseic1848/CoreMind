import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProcessRunner } from "coremind-tools";
import { inspectReleaseManifest } from "./p0-acceptance.mjs";
import { createNpmPublishPlan, npmTarballIntegrity } from "./publish-npm-artifacts.mjs";
import { createArtifactRecords } from "./release-artifacts.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProbe = path.join(path.dirname(scriptPath), "paired-evaluation-probe.mjs");
const armIds = ["baseline", "candidate"];
const caseIds = ["typescript-defect", "python-defect"];
const unavailableMetrics = /cost|usage|ttft|cache|^(?:input|output)?tokens$/iu;
const runner = new ProcessRunner();

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function canonicalDestination(directory) {
  try {
    return await realpath(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert(path.dirname(directory) !== directory, "证据目录所在卷不存在");
    return path.join(await canonicalDestination(path.dirname(directory)), path.basename(directory));
  }
}

/** 固定完整矩阵；输入形状校验不触发安装或读取被测 SDK。 */
export function freezePairedPlan(input) {
  assert(object(input) && input.schemaVersion === 1, "配对输入 schemaVersion 必须为 1");
  assert(Array.isArray(input.arms) && input.arms.length === 2, "必须指定两个评测臂");
  assert(new Set(input.arms.map((arm) => arm.id)).size === 2, "评测臂不能重复");
  const arms = armIds.map((id) => {
    const arm = input.arms.find((item) => item.id === id);
    assert(arm && path.isAbsolute(arm.artifactRoot ?? ""), `评测臂 ${id} 缺少绝对制品目录`);
    assert(/^[a-f0-9]{64}$/u.test(arm.manifestSha256 ?? ""), `${id} 清单摘要无效`);
    assert(/^[a-f0-9]{40}$/u.test(arm.commit ?? ""), `${id} 提交身份无效`);
    return Object.freeze({
      id,
      artifactRoot: path.resolve(arm.artifactRoot),
      manifestSha256: arm.manifestSha256,
      commit: arm.commit,
    });
  });
  assert(
    object(input.fixtures) && path.isAbsolute(input.fixtures.root ?? ""),
    "夹具根必须是绝对路径",
  );
  assert(/^[a-f0-9]{64}$/u.test(input.fixtures.sha256 ?? ""), "夹具摘要无效");
  assert(
    Array.isArray(input.cases) &&
      input.cases.length === 2 &&
      caseIds.every((id) => input.cases.includes(id)),
    "必须指定两个既有缺陷场景",
  );
  assert(input.repetitions === 3, "离线配对固定重复三次");
  assert(path.isAbsolute(input.outputDirectory ?? ""), "证据目录必须是绝对路径");
  const cells = [];
  let pair = 0;
  for (const caseId of caseIds) {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const order = pair++ % 2 === 0 ? armIds : [...armIds].reverse();
      for (const armId of order)
        cells.push(
          Object.freeze({ id: `${caseId}:${repetition}:${armId}`, caseId, armId, repetition }),
        );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    arms: Object.freeze(arms),
    fixtures: Object.freeze({
      root: path.resolve(input.fixtures.root),
      sha256: input.fixtures.sha256,
    }),
    cases: Object.freeze([...caseIds]),
    repetitions: 3,
    outputDirectory: path.resolve(input.outputDirectory),
    cells: Object.freeze(cells),
  });
}

async function inspectTree(root) {
  const canonical = await realpath(root);
  assert((await lstat(canonical)).isDirectory(), "冻结根必须是目录");
  const entries = [];
  const files = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(canonical, file).replaceAll("\\", "/");
      const info = await lstat(file);
      if (info.isSymbolicLink()) {
        const target = await realpath(file);
        assert(inside(canonical, target), `链接越出冻结根：${relative}`);
        entries.push({ path: relative, type: "link", target: await readlink(file) });
      } else if (info.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        await visit(file);
      } else {
        assert(info.isFile(), `冻结树包含非普通文件：${relative}`);
        files.push(file);
      }
    }
  }
  await visit(canonical);
  // 固定八路完整读取，避免安装树的小文件校验被串行 I/O 放大。
  const lanes = Array.from({ length: Math.min(8, files.length) }, () => []);
  for (const [index, file] of files.entries()) lanes[index % lanes.length].push(file);
  const settled = await Promise.allSettled(
    lanes.map((lane) => createArtifactRecords(canonical, lane)),
  );
  const records = [];
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason;
    records.push(...result.value);
  }
  entries.push(...records.map((record) => ({ ...record, type: "file" })));
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    sha256: digest(`${JSON.stringify(entries)}\n`),
    bytes: records.reduce((sum, item) => sum + item.size, 0),
    productionBytes: records
      .filter((item) => item.path.startsWith("node_modules/"))
      .reduce((sum, item) => sum + item.size, 0),
    files: records.length,
  };
}

/** 按相对路径、真实字节与内部链接目标冻结夹具或安装树。 */
export async function fingerprintTree(root) {
  return (await inspectTree(root)).sha256;
}

function childEnvironment(home) {
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "TZ",
    "APPDATA",
    "LOCALAPPDATA",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())),
  );
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TEMP: home,
    TMP: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    PYTHONDONTWRITEBYTECODE: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
}

function failedCell(cell, error, evidence = {}) {
  return {
    schemaVersion: 1,
    cellId: cell.id,
    caseId: cell.caseId,
    armId: cell.armId,
    repetition: cell.repetition,
    status: "failed",
    qualityPassed: false,
    safetyPassed: false,
    metrics: {},
    grading: {},
    evidence,
    errors: [error instanceof Error ? error.message : String(error)],
  };
}

function validateResult(cell, result) {
  assert(object(result) && result.schemaVersion === 1, "子探针返回格式无效");
  assert(
    result.cellId === cell.id &&
      result.caseId === cell.caseId &&
      result.armId === cell.armId &&
      result.repetition === cell.repetition,
    "子探针格子身份不一致",
  );
  assert(["succeeded", "failed"].includes(result.status), "子探针状态无效");
  assert(
    typeof result.qualityPassed === "boolean" && typeof result.safetyPassed === "boolean",
    "缺少质量或安全结论",
  );
  assert(
    object(result.metrics) && object(result.grading) && object(result.evidence),
    "子探针指标或证据格式无效",
  );
  assert(
    Array.isArray(result.errors) && result.errors.every((error) => typeof error === "string"),
    "子探针错误列表无效",
  );
  for (const [name, value] of Object.entries(result.metrics)) {
    assert(
      value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0),
      `指标 ${name} 必须非负有限或 null`,
    );
    assert(!unavailableMetrics.test(name) || value === null, `离线指标 ${name} 必须为 null`);
  }
  return result;
}

/** 每格真实独立进程；复用生产监督器完成超时、输出限制与进程树回收。 */
export async function executeProbe(
  request,
  {
    probePath = defaultProbe,
    nodePath = process.execPath,
    timeoutMs = 120_000,
    maxOutputBytes = 8 * 1024 * 1024,
    home = request.workspace,
  } = {},
) {
  const started = performance.now();
  try {
    const execution = await runner.run({
      command: nodePath,
      args: [probePath],
      cwd: request.workspace,
      env: childEnvironment(home),
      input: `${JSON.stringify(request)}\n`,
      timeoutMs,
      maxOutputBytes,
    });
    const processEvidence = {
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      stderr: execution.stderr,
    };
    if (execution.failed || execution.exitCode !== 0) {
      return failedCell(request.cell, `子探针异常退出：${execution.exitCode}`, {
        process: processEvidence,
        rawStdout: execution.stdout,
      });
    }
    let result;
    try {
      result = validateResult(request.cell, JSON.parse(execution.stdout));
    } catch (error) {
      return failedCell(request.cell, error, {
        process: processEvidence,
        rawStdout: execution.stdout,
      });
    }
    return {
      ...result,
      metrics: { ...result.metrics, processMs: performance.now() - started },
      evidence: { ...result.evidence, process: processEvidence },
    };
  } catch (error) {
    return failedCell(request.cell, error, {
      process: { code: error.code ?? "process_failed", durationMs: performance.now() - started },
    });
  }
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : sorted[middle - 1] / 2 + sorted[middle] / 2;
}

/** 只聚合完整且质量、安全均通过的配对；缺失指标不以零补齐。 */
export function summarizePairedReport(plan, results) {
  const errors = [];
  const byId = new Map();
  const names = new Set();
  for (const result of results) {
    const cell = plan.cells.find((item) => item.id === result?.cellId);
    try {
      assert(cell, "存在计划之外的结果");
      validateResult(cell, result);
      assert(!byId.has(cell.id), `格子重复：${cell.id}`);
      byId.set(cell.id, result);
      for (const name of Object.keys(result.metrics)) names.add(name);
    } catch (error) {
      errors.push(error.message);
    }
  }
  for (const cell of plan.cells) if (!byId.has(cell.id)) errors.push(`缺少格子：${cell.id}`);
  const complete = errors.length === 0 && results.length === plan.cells.length;
  const successful = (row) =>
    row?.status === "succeeded" && row.qualityPassed && row.safetyPassed && row.errors.length === 0;
  const failedCells = plan.cells.filter((cell) => !successful(byId.get(cell.id))).length;
  const qualified = complete && failedCells === 0;
  const pairs = [];
  for (const caseId of plan.cases) {
    for (let repetition = 1; repetition <= plan.repetitions; repetition++) {
      const baseline = byId.get(`${caseId}:${repetition}:baseline`);
      const candidate = byId.get(`${caseId}:${repetition}:candidate`);
      const eligible = complete && successful(baseline) && successful(candidate);
      const metrics = {};
      if (eligible) {
        for (const name of names) {
          const before = baseline.metrics[name];
          const after = candidate.metrics[name];
          if (typeof before !== "number" || typeof after !== "number") continue;
          const percentChange = before === 0 ? null : ((after - before) / before) * 100;
          metrics[name] = {
            baseline: before,
            candidate: after,
            delta: after - before,
            percentChange: Number.isFinite(percentChange) ? percentChange : null,
          };
        }
      }
      pairs.push({ caseId, repetition, eligible, metrics });
    }
  }
  const metrics = Object.fromEntries(
    [...names].sort().map((name) => {
      const observations = pairs.map((pair) => pair.metrics[name]).filter(Boolean);
      const medianDelta = median(observations.map((item) => item.delta));
      const medianPercentChange = median(
        observations.map((item) => item.percentChange).filter((value) => value !== null),
      );
      const conclusion =
        !qualified || observations.length !== pairs.length
          ? "unavailable"
          : medianDelta < 0
            ? "candidate_lower"
            : medianDelta > 0
              ? "candidate_higher"
              : "no_clear_improvement";
      return [
        name,
        { pairedCount: observations.length, medianDelta, medianPercentChange, conclusion },
      ];
    }),
  );
  return {
    scope: "offline_fixed_fixture",
    complete,
    qualified,
    plannedCells: plan.cells.length,
    completedCells: byId.size,
    failedCells,
    errors,
    pairs,
    metrics,
  };
}

async function inspectArtifacts(arm) {
  const artifactRoot = await realpath(arm.artifactRoot);
  const bytes = await readFile(path.join(artifactRoot, "release-manifest.json"));
  assert(digest(bytes) === arm.manifestSha256, `${arm.id} 清单字节摘要不一致`);
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const manifest = JSON.parse(raw);
  const report = await inspectReleaseManifest(raw, {
    artifactRoot,
    targetVersion: manifest.version,
    commit: arm.commit,
    ref: arm.id,
  });
  assert(report.blockers.length === 0, report.blockers.join("；"));
  const artifacts = createNpmPublishPlan(manifest);
  return { artifactRoot, manifest, artifacts, manifestBytes: bytes };
}

async function prepareArm(arm, temporaryRoot, home, outputDirectory) {
  const inspected = await inspectArtifacts(arm);
  const installRoot = path.join(temporaryRoot, arm.id);
  await mkdir(installRoot);
  for (let directory = path.dirname(installRoot); ; directory = path.dirname(directory)) {
    try {
      await lstat(path.join(directory, "node_modules"));
      throw new Error("隔离安装根的祖先存在共享 node_modules");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (path.dirname(directory) === directory) break;
  }
  await writeFile(
    path.join(installRoot, "package.json"),
    `${JSON.stringify({ name: `coremind-paired-${arm.id}`, private: true, type: "module" })}\n`,
    "utf8",
  );
  const npmCli = process.env.npm_execpath;
  assert(npmCli && path.isAbsolute(npmCli), "请通过 npm run eval:paired 提供固定 npm_execpath");
  const npmCliPath = await realpath(npmCli);
  const tarballs = inspected.artifacts.map((item) =>
    path.resolve(inspected.artifactRoot, item.path),
  );
  const installed = await runner.run({
    command: process.execPath,
    args: [
      npmCliPath,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--package-lock=true",
      "--save-exact",
      ...tarballs,
    ],
    cwd: installRoot,
    env: childEnvironment(home),
    timeoutMs: 180_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  assert(!installed.failed && installed.exitCode === 0, `${arm.id} 安装失败：${installed.stderr}`);
  const lockBytes = await readFile(path.join(installRoot, "package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8"));
  assert(object(lock.packages), "安装锁缺少完整 packages");
  const names = new Set(inspected.artifacts.map((item) => item.name));
  const found = new Set();
  for (const [location, item] of Object.entries(lock.packages)) {
    const name = location.split("node_modules/").at(-1);
    if (!names.has(name)) continue;
    assert(
      location === `node_modules/${name}` && !found.has(name),
      `存在嵌套或重复 CoreMind 包：${location}`,
    );
    found.add(name);
    const artifact = inspected.artifacts.find((entry) => entry.name === name);
    assert(
      item.version === inspected.manifest.version &&
        typeof item.resolved === "string" &&
        item.resolved.startsWith("file:"),
      `${name} 不是本臂本地包`,
    );
    const resolved = fileURLToPath(
      new URL(item.resolved, pathToFileURL(`${installRoot}${path.sep}`)),
    );
    const expected = await realpath(path.join(inspected.artifactRoot, artifact.path));
    assert((await realpath(resolved)) === expected, `${name} 回落到其他制品`);
    assert(
      item.integrity === npmTarballIntegrity(await readFile(expected)),
      `${name} 安装锁完整性不一致`,
    );
  }
  assert(found.size === 8, "安装锁未固定完整八包");
  for (const name of names) {
    const directory = await realpath(path.join(installRoot, "node_modules", name));
    assert(inside(installRoot, directory), `${name} 解析越出隔离根`);
    const packageJson = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    assert(
      packageJson.name === name && packageJson.version === inspected.manifest.version,
      `${name} 实际安装身份不一致`,
    );
  }
  const entries = {};
  const entrySha256 = {};
  for (const [name, relative] of Object.entries({
    sdkEntry: "coremind-ai/dist/index.js",
    cliEntry: "coremind-cli/dist/cli.js",
    workerEntry: "coremind-worker/dist/stdio.js",
  })) {
    const file = await realpath(path.join(installRoot, "node_modules", relative));
    assert(inside(installRoot, file), `入口 ${name} 越出隔离根`);
    entries[name] = file;
    entrySha256[name] = digest(await readFile(file));
  }
  const tree = await inspectTree(installRoot);
  await writeFile(path.join(outputDirectory, `${arm.id}-package-lock.json`), lockBytes);
  await writeFile(
    path.join(outputDirectory, `${arm.id}-release-manifest.json`),
    inspected.manifestBytes,
  );
  return {
    ...arm,
    artifactRoot: inspected.artifactRoot,
    version: inspected.manifest.version,
    installRoot,
    lockSha256: digest(lockBytes),
    installTreeSha256: tree.sha256,
    ...entries,
    entrySha256,
    artifacts: inspected.artifacts,
    sizes: {
      npmTarballBytes: inspected.artifacts.reduce((sum, item) => sum + item.size, 0),
      installedProductionBytes: tree.productionBytes,
      workerEntryBytes: (await lstat(entries.workerEntry)).size,
    },
    installation: {
      nodeVersion: process.version,
      npmCliSha256: digest(await readFile(npmCliPath)),
      durationMs: installed.durationMs,
    },
  };
}

async function verifyFrozenArm(arm) {
  await inspectArtifacts(arm);
  assert(
    (await fingerprintTree(arm.installRoot)) === arm.installTreeSha256,
    `${arm.id} 安装树已变化`,
  );
}

async function verifySources(plan, harness) {
  assert((await fingerprintTree(plan.fixtures.root)) === plan.fixtures.sha256, "夹具字节已变化");
  assert(digest(await readFile(scriptPath)) === harness.coordinatorSha256, "协调器字节已变化");
  assert(digest(await readFile(harness.probePath)) === harness.probeSha256, "探针字节已变化");
}

/** 一次准备两臂，先写计划，再顺序执行全部格子，所有可执行准备失败也入账。 */
export async function runPairedEvaluation(input, options = {}) {
  const requestedPlan = freezePairedPlan(input);
  const plan = Object.freeze({
    ...requestedPlan,
    outputDirectory: await canonicalDestination(requestedPlan.outputDirectory),
  });
  for (const root of [plan.fixtures.root, ...plan.arms.map((arm) => arm.artifactRoot)]) {
    const canonical = await realpath(root).catch(() => path.resolve(root));
    assert(!inside(canonical, plan.outputDirectory), "证据目录不能写入冻结制品或夹具");
  }
  await mkdir(plan.outputDirectory, { recursive: true });
  assert((await readdir(plan.outputDirectory)).length === 0, "证据目录必须为空，禁止混入旧账目");
  await writeFile(
    path.join(plan.outputDirectory, "plan.json"),
    `${JSON.stringify(plan, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const results = [];
  const errors = [];
  const identity = {
    arms: [],
    fixtures: plan.fixtures,
    harness: {},
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? null,
      cpuCount: os.cpus().length,
    },
  };
  let temporaryRoot;
  try {
    temporaryRoot = await realpath(
      await mkdtemp(path.join(await realpath(os.tmpdir()), "coremind-paired-")),
    );
    const home = path.join(temporaryRoot, "home");
    await mkdir(home);
    const probePath = await realpath(options.probePath ?? defaultProbe);
    const processRunnerPath = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("coremind-tools"))),
      "process-runner.js",
    );
    identity.harness = {
      probePath,
      probeSha256: digest(await readFile(probePath)),
      coordinatorSha256: digest(await readFile(scriptPath)),
      processRunnerSha256: digest(await readFile(processRunnerPath)),
    };
    await verifySources(plan, identity.harness);
    for (const arm of plan.arms)
      identity.arms.push(await prepareArm(arm, temporaryRoot, home, plan.outputDirectory));
    for (const cell of plan.cells) {
      let workspace;
      let row;
      try {
        const arm = identity.arms.find((item) => item.id === cell.armId);
        await verifySources(plan, identity.harness);
        await verifyFrozenArm(arm);
        workspace = await mkdtemp(path.join(temporaryRoot, "cell-"));
        const cellHome = await mkdtemp(path.join(temporaryRoot, "cell-home-"));
        row = await executeProbe(
          {
            schemaVersion: 1,
            cell,
            arm: {
              version: arm.version,
              sdkEntry: arm.sdkEntry,
              cliEntry: arm.cliEntry,
              workerEntry: arm.workerEntry,
            },
            fixtureRoot: plan.fixtures.root,
            workspace,
          },
          { ...options, probePath, home: cellHome },
        );
        row.metrics = { ...row.metrics, ...arm.sizes };
        row.evidence = { ...row.evidence, workspace };
      } catch (error) {
        row = failedCell(cell, error);
      } finally {
        if (workspace) {
          try {
            assert(
              (await realpath(workspace)) === workspace &&
                path.dirname(workspace) === temporaryRoot,
              "拒绝清理非自有工作区",
            );
            await rm(workspace, { recursive: true, force: true });
          } catch (error) {
            row = failedCell(cell, `工作区清理失败：${error.message}`, { previous: row });
          }
        }
      }
      results.push(row);
      await appendFile(
        path.join(plan.outputDirectory, "results.jsonl"),
        `${JSON.stringify(row)}\n`,
        "utf8",
      );
    }
    await verifySources(plan, identity.harness);
    for (const arm of identity.arms) await verifyFrozenArm(arm);
  } catch (error) {
    errors.push(error.message);
    for (const cell of plan.cells) {
      if (results.some((row) => row.cellId === cell.id)) continue;
      const row = failedCell(cell, `准备失败：${error.message}`);
      results.push(row);
      await appendFile(
        path.join(plan.outputDirectory, "results.jsonl"),
        `${JSON.stringify(row)}\n`,
        "utf8",
      );
    }
  } finally {
    if (temporaryRoot) {
      try {
        assert(
          (await realpath(temporaryRoot)) === temporaryRoot &&
            path.dirname(temporaryRoot) === (await realpath(os.tmpdir())) &&
            path.basename(temporaryRoot).startsWith("coremind-paired-"),
          "拒绝清理非自有临时根",
        );
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        errors.push(`临时资源清理失败：${error.message}`);
      }
    }
  }
  const summary = summarizePairedReport(plan, results);
  if (errors.length > 0) {
    summary.qualified = false;
    summary.errors.push(...errors);
    for (const metric of Object.values(summary.metrics)) metric.conclusion = "unavailable";
  }
  const report = {
    schemaVersion: 1,
    plan,
    identity,
    results,
    summary,
    limitations: [
      "仅证明固定离线夹具；不代表真实模型质量、Provider TTFT、费用或缓存收益。",
      "新进程不等于操作系统冷缓存；冷态与热态指标分别记录。",
      "两臂依赖锁属于本次受控安装，不冒充历史发布时的传递依赖树。",
    ],
  };
  await writeFile(
    path.join(plan.outputDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    assert(
      process.argv.length === 4 && process.argv[2] === "--input",
      "用法：npm run eval:paired -- --input <JSON文件>",
    );
    const input = JSON.parse(await readFile(path.resolve(process.argv[3]), "utf8"));
    const report = await runPairedEvaluation(input);
    process.stdout.write(
      `配对离线报告：${path.join(report.plan.outputDirectory, "report.json")}\n`,
    );
    if (!report.summary.qualified) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
