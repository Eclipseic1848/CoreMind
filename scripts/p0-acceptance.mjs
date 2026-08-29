import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifactRecords } from "./release-artifacts.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P0_TARGET_VERSION = "0.7.0";

const CHECK_TITLES = [
  "委派默认关闭与创建前拒绝",
  "Delegation Tool 创建命名 Child Run",
  "委派批准矩阵与独立 Effect 审批",
  "最小 Delegated Context",
  "预算与层级单调收紧",
  "项目 Provider 与目标 Agent 路由",
  "共享 Workspace 与单 Writer",
  "Child Run 终态处置",
  "DelegationId 幂等与安全重试",
  "取消与 Quiescent 收敛",
  "崩溃恢复与孤儿审计",
  "CLI、TUI、TypeScript、Python 四入口等价",
  "Protocol v2 与 bundled Worker 一致",
  "Error Contract 完整性",
  "Execution Security Gate 等价",
  "工程门与候选资格门分离",
  "main 保护规则",
  "0.7.0 版本与发布元数据一致",
  "双平台候选包安装验收",
  "真实 Provider 父子 Agent 验收",
  "同源公开发布",
  "npm 与 PyPI 公开回装",
];

export const P0_CHECKS = CHECK_TITLES.map((title, index) => ({
  id: `P0-${String(index + 1).padStart(2, "0")}`,
  title,
}));

export const P0_STAGES = ["engineering", "candidate", "release", "post-release"];
const ENGINEERING_PLAN = [
  commandStep("quality", "npm", ["run", "check"]),
  commandStep("security", "npm", ["run", "security:audit"]),
  commandStep("build", "npm", ["run", "build"]),
  commandStep("workspaceLease", "npm", ["run", "acceptance:workspace-lease"]),
  commandStep("dependencies", "npm", ["run", "dependencies:check"]),
  commandStep("docs", "npm", ["run", "docs:build"]),
  commandStep("providerMatrix", "npm", ["run", "providers:matrix"]),
  commandStep("providerMatrixClean", "git", ["diff", "--exit-code", "--", "docs/providers"]),
  commandStep("engineeringTests", "npm", ["run", "test:engineering", "--", "--maxWorkers=2"]),
  commandStep("pythonWorker", "npm", ["run", "build:python-worker"]),
  commandStep("pythonSdk", "python", [
    "-W",
    "error::ResourceWarning",
    "-m",
    "unittest",
    "discover",
    "-s",
    "python/tests",
    "-p",
    "test_*.py",
    "-v",
  ]),
  commandStep("pythonExample", "python", [
    "-W",
    "error::ResourceWarning",
    "-m",
    "unittest",
    "discover",
    "-s",
    "examples/golden/python-data-analysis/tests",
    "-p",
    "test_*.py",
    "-v",
  ]),
];
const CANDIDATE_PLAN = [
  ...ENGINEERING_PLAN,
  commandStep("baseline", "npm", ["run", "baseline:check"]),
  commandStep("stability", "npm", ["run", "test:stability"]),
  commandStep("coverage", "npm", ["run", "test:coverage"]),
  commandStep("tty", "npm", ["run", "acceptance:tty"]),
  commandStep("sourcePackage", "npm", ["run", "release:test-source"]),
];
export const P0_EXECUTION_PLAN = {
  engineering: ENGINEERING_PLAN,
  candidate: [
    ...CANDIDATE_PLAN,
    commandStep("rc", "npm", ["run", "acceptance:rc", "--", "--defer-provider-certification"]),
  ],
  release: [...CANDIDATE_PLAN, commandStep("rc", "npm", ["run", "acceptance:rc"])],
  "post-release": [...CANDIDATE_PLAN, commandStep("rc", "npm", ["run", "acceptance:rc"])],
};

const ENGINEERING_CHECKS = new Set([
  "P0-01",
  "P0-03",
  "P0-05",
  "P0-09",
  "P0-10",
  "P0-12",
  "P0-14",
  "P0-15",
]);
const LOCAL_CHECKS = new Set([...P0_CHECKS.slice(0, 16).map((check) => check.id), "P0-18"]);
const LOCAL_REFS = {
  "P0-01": ["packages/coremind-runtime/src/delegation-tool.acceptance.test.ts"],
  "P0-02": ["packages/coremind-runtime/src/delegation-tool.acceptance.test.ts"],
  "P0-03": ["packages/coremind-runtime/src/delegation-tool.acceptance.test.ts"],
  "P0-04": ["packages/coremind-runtime/src/delegated-context.test.ts"],
  "P0-05": ["packages/coremind-runtime/src/child-run.test.ts"],
  "P0-06": ["packages/coremind-runtime/src/child-runtime-adapter.test.ts"],
  "P0-07": [
    "packages/coremind-runtime/src/workspace-lease.test.ts",
    "packages/coremind-runtime/src/child-run.test.ts",
  ],
  "P0-08": ["packages/coremind-runtime/src/child-run.test.ts"],
  "P0-09": ["packages/coremind-runtime/src/child-run.test.ts"],
  "P0-10": ["packages/coremind-runtime/src/child-run.test.ts"],
  "P0-11": [
    "packages/coremind-runtime/src/child-run.test.ts",
    "packages/coremind-worker/src/protocol-host.test.ts",
  ],
  "P0-12": ["packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx"],
  "P0-13": [
    "packages/coremind-worker/src/protocol-host.test.ts",
    "python/tests/test_node_parity.py",
  ],
  "P0-14": ["packages/coremind-protocol/src/error-contract.test.ts"],
  "P0-15": ["packages/coremind-runtime/src/execution-security.acceptance.test.ts"],
  "P0-16": ["scripts/workflow-contract.test.ts"],
  "P0-18": ["scripts/release-version.test.ts", "scripts/release-preflight.test.ts"],
  "P0-19": [".scratch/rc-evidence/rc-tty-windows.json", ".scratch/rc-evidence/rc-tty-linux.json"],
};
const OFFLINE_SEAM_ANCHORS = {
  entryEquivalence: [
    [
      "packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx",
      "四入口对同一 Child Run 失败保持错误",
    ],
  ],
  runtimeWorkerFaults: [
    ["packages/coremind-runtime/src/child-run.test.ts", "独立 Child Worker 未知崩溃"],
    ["packages/coremind-worker/src/protocol-host.test.ts", "正式 Child Run 在 Host 崩溃后"],
  ],
};
const EVIDENCE_LEVELS = new Set([
  "offline",
  "repository-policy",
  "dual-platform",
  "candidate-package",
  "live-provider",
  "public-release",
  "public-reinstall",
]);
const EXTERNAL_REQUIREMENTS = {
  "P0-17": [{ level: "repository-policy", missing: "repository-policy 证据" }],
  "P0-19": [
    ...["win32", "linux"].map((platform) => ({
      level: "dual-platform",
      platform,
      missing: `${platform} 双平台证据`,
    })),
    ...["win32", "linux"].flatMap((platform) =>
      ["npm", "pypi"].map((channel) => ({
        level: "candidate-package",
        platform,
        channel,
        missing: `${platform}/${channel} 候选包证据`,
      })),
    ),
  ],
  "P0-20": [{ level: "live-provider", missing: "live-provider 证据" }],
  "P0-21": [
    ...["git-tag", "github-release", "npm", "pypi"].map((channel) => ({
      level: "public-release",
      channel,
      missing: `${channel} 公开发布证据`,
    })),
  ],
  "P0-22": [
    ...["npm", "pypi"].map((channel) => ({
      level: "public-reinstall",
      channel,
      missing: `${channel} 公开回装证据`,
    })),
  ],
};

export function createP0AcceptanceReport(input) {
  if (!P0_STAGES.includes(input.stage)) throw new Error(`未知 P0 验收阶段：${input.stage}`);
  const requiredIds = requiredCheckIds(input.stage);
  const blockers = [...validateReportTarget(input), ...(input.inputBlockers ?? [])];
  const evidenceByCheck = new Map();

  for (const evidence of input.evidence ?? []) {
    const checkBlockers = validateEvidence(evidence, input);
    const current = evidenceByCheck.get(evidence?.checkId) ?? [];
    current.push({ evidence, blockers: checkBlockers });
    evidenceByCheck.set(evidence?.checkId, current);
    blockers.push(...checkBlockers);
  }

  const checks = P0_CHECKS.map((definition) => {
    const required = requiredIds.has(definition.id);
    const supplied = evidenceByCheck.get(definition.id) ?? [];
    const checkBlockers = supplied.flatMap((item) => item.blockers);
    const localBlocker = localCheckBlocker(definition.id, input.stage, input.suiteResults);
    if (required && localBlocker) {
      const message = `${definition.id} ${localBlocker}`;
      checkBlockers.push(message);
      blockers.push(message);
    }
    if (required && EXTERNAL_REQUIREMENTS[definition.id]) {
      for (const requirement of EXTERNAL_REQUIREMENTS[definition.id]) {
        const matched = supplied.some(
          (item) =>
            item.blockers.length === 0 &&
            item.evidence.evidenceLevel === requirement.level &&
            (!requirement.platform || item.evidence.platform === requirement.platform) &&
            (!requirement.channel || item.evidence.channel === requirement.channel),
        );
        if (!matched) {
          const message = `${definition.id} 缺少 ${requirement.missing}`;
          checkBlockers.push(message);
          blockers.push(message);
        }
      }
    }

    let status = "not_required";
    if (required) {
      if (checkBlockers.length > 0) status = "failed";
      else status = "passed";
    } else if (checkBlockers.length > 0) {
      status = "failed";
    }

    return {
      ...definition,
      required,
      status,
      evidenceLevels: [
        ...(LOCAL_CHECKS.has(definition.id) && required ? ["offline"] : []),
        ...(definition.id === "P0-19" && required && input.suiteResults?.tty === true
          ? ["automated-real-tty"]
          : []),
        ...supplied.map((item) => item.evidence.evidenceLevel),
      ],
      refs: [
        ...(required ? (LOCAL_REFS[definition.id] ?? []) : []),
        ...supplied.map((item) => item.evidence.sourceRef).filter(Boolean),
        ...supplied.map((item) => item.evidence.ref).filter(Boolean),
      ],
      evidenceDigests: supplied.map((item) => item.evidence.sourceDigest).filter(Boolean),
      reasons: checkBlockers,
    };
  });

  return {
    schemaVersion: 1,
    stage: input.stage,
    targetVersion: input.targetVersion,
    commit: input.commit,
    runtimeDigest: input.runtimeDigest,
    artifacts: input.artifacts ?? null,
    platform: input.platform,
    generatedAt: input.generatedAt,
    sourceClean: input.sourceClean,
    passed: blockers.length === 0 && checks.filter((check) => check.required).every(isPassed),
    suiteResults: input.suiteResults,
    checks,
    blockers,
  };
}

export function parseP0Arguments(args) {
  const options = {
    stage: "candidate",
    targetVersion: P0_TARGET_VERSION,
    artifactManifest: null,
    evidenceFiles: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (["--stage", "--artifact-manifest", "--evidence"].includes(argument)) {
      if (!value || value.startsWith("--")) throw new Error(`${argument} 缺少值`);
      index += 1;
    }
    if (argument === "--stage") options.stage = value;
    else if (argument === "--artifact-manifest") options.artifactManifest = value;
    else if (argument === "--evidence") options.evidenceFiles.push(value);
    else throw new Error(`未知参数：${argument}`);
  }
  if (!P0_STAGES.includes(options.stage)) throw new Error(`未知 P0 验收阶段：${options.stage}`);
  if (options.stage !== "engineering" && !options.artifactManifest) {
    throw new Error(`${options.stage} 阶段必须提供 --artifact-manifest`);
  }
  return options;
}

export async function runP0Acceptance(options, root = repositoryRoot) {
  const generatedAt = new Date().toISOString();
  const identity = gitIdentity(root);
  const commit = identity.commit;
  const rootManifest = await readJson(path.join(root, "package.json"));
  const workerManifest = await readJson(
    path.join(root, "python", "src", "coremind", "_worker", "manifest.json"),
  );
  const runtimeDigest = `sha256:${workerManifest.bundleSha256}`;
  const inputBlockers = [];
  if (!identity.clean) inputBlockers.push("验收开始时 Git 工作区不干净");
  let artifacts = null;
  if (options.artifactManifest) {
    try {
      const manifestPath = path.resolve(root, options.artifactManifest);
      const inspected = await inspectReleaseManifest(await readFile(manifestPath, "utf8"), {
        targetVersion: options.targetVersion,
        commit,
        ref: path.relative(root, manifestPath),
        artifactRoot: path.dirname(manifestPath),
      });
      artifacts = inspected.summary;
      inputBlockers.push(...inspected.blockers);
    } catch (error) {
      inputBlockers.push(`候选产物 manifest 不可读：${errorMessage(error)}`);
    }
  }
  const commandResults = {};
  let failedStep = null;
  if (identity.clean) {
    for (const step of P0_EXECUTION_PLAN[options.stage]) {
      const completed = runCommand(root, step);
      commandResults[step.name] = completed.status === 0;
      if (completed.status !== 0) {
        failedStep = step.name;
        inputBlockers.push(`${options.stage} 编排步骤未通过：${step.name}`);
        break;
      }
    }
  }
  let rcReport = null;
  let rcSuitesReady = false;
  if (options.stage !== "engineering") {
    try {
      if (commandResults.rc !== true) throw new Error("RC 步骤未成功执行");
      rcReport = await readJson(
        path.join(root, ".scratch", `rc-acceptance-${process.platform}.json`),
      );
    } catch (error) {
      inputBlockers.push(`RC 报告不可读：${errorMessage(error)}`);
    }
    if (rcReport?.commit !== commit) inputBlockers.push("RC 报告提交与当前提交不一致");
    if (rcReport?.automatedReady !== true) inputBlockers.push("RC 自动验收未通过");
    if (rcReport?.ready !== true) inputBlockers.push("RC 双平台真实 TTY 证据未通过");
    rcSuitesReady = ["node", "python", "metadata", "artifacts"].every(
      (name) => rcReport?.suiteResults?.[name] === true,
    );
    if (!rcSuitesReady) inputBlockers.push("RC 子套件证据不完整");
  }

  const seams = await inspectOfflineSeams(root, requiredCheckIds(options.stage));
  const loaded = await loadEvidenceFiles(root, options.evidenceFiles);
  inputBlockers.push(...loaded.blockers);
  const finalIdentity = gitIdentity(root);
  inputBlockers.push(...validateStableSourceIdentity(identity, finalIdentity));
  const sourceClean =
    identity.clean && finalIdentity.clean && identity.commit === finalIdentity.commit;
  const planPassed = identity.clean && !failedStep && sourceClean;
  const engineeringReady = options.stage === "engineering" && planPassed;
  const rcReady =
    options.stage !== "engineering" &&
    planPassed &&
    rcReport?.commit === commit &&
    rcReport?.automatedReady === true &&
    rcReport?.ready === true;
  const report = createP0AcceptanceReport({
    stage: options.stage,
    targetVersion: options.targetVersion,
    commit,
    runtimeDigest,
    artifacts,
    platform: process.platform,
    generatedAt,
    sourceClean,
    suiteResults: {
      engineering: engineeringReady,
      rc: rcReady && rcSuitesReady,
      entryEquivalence: (engineeringReady || rcReady) && seams.entryEquivalence,
      runtimeWorkerFaults: (engineeringReady || rcReady) && seams.runtimeWorkerFaults,
      tty: options.stage !== "engineering" && rcReport?.ready === true,
      version:
        rootManifest.version === options.targetVersion &&
        workerManifest.version === options.targetVersion,
      localRefs: seams.localRefs,
      commands: commandResults,
    },
    evidence: loaded.evidence,
    inputBlockers,
  });
  const outputDirectory = path.join(root, ".scratch");
  await mkdir(outputDirectory, { recursive: true });
  const output = path.join(
    outputDirectory,
    `p0-acceptance-${options.stage}-${process.platform}.json`,
  );
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, output };
}

export async function inspectReleaseManifest(raw, expected) {
  const blockers = [];
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    return { summary: null, blockers: [`候选产物 manifest 不是有效 JSON：${errorMessage(error)}`] };
  }
  if (manifest.schemaVersion !== 1) blockers.push("候选产物 manifest schemaVersion 必须为 1");
  if (manifest.version !== expected.targetVersion) blockers.push("候选产物 manifest 版本不一致");
  if (manifest.commit !== expected.commit) blockers.push("候选产物 manifest 提交不一致");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    blockers.push("候选产物 manifest 缺少 artifacts");
  }
  const artifactPaths = new Set();
  const artifactFiles = new Set();
  const items = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.map((item, index) =>
        validateArtifactItem(item, index, expected, blockers, artifactPaths),
      )
    : [];
  for (const kind of ["npm", "python"]) {
    if (!items.some((item) => item.kind === kind))
      blockers.push(`候选产物 manifest 缺少 ${kind} 产物`);
  }
  let artifactRoot = null;
  try {
    artifactRoot = await realpath(expected.artifactRoot);
  } catch (error) {
    blockers.push(`候选产物目录不可读：${errorMessage(error)}`);
  }
  for (const [index, item] of items.entries()) {
    if (!artifactRoot) break;
    const label = `候选产物 manifest artifacts[${index}]`;
    const declaredPath = path.resolve(artifactRoot, item.path ?? "");
    if (!isPathInside(artifactRoot, declaredPath)) {
      blockers.push(`${label}.path 必须位于候选产物目录内`);
      continue;
    }
    try {
      const artifactPath = await realpath(declaredPath);
      if (!isPathInside(artifactRoot, artifactPath)) {
        blockers.push(`${label}.path 必须位于候选产物目录内`);
        continue;
      }
      const artifactKey = process.platform === "win32" ? artifactPath.toLowerCase() : artifactPath;
      if (artifactFiles.has(artifactKey)) blockers.push(`${label} 实际路径重复`);
      artifactFiles.add(artifactKey);
      const [actual] = await createArtifactRecords(artifactRoot, [artifactPath]);
      if (actual.size !== item.size) blockers.push(`${label} 实际大小不一致`);
      if (actual.sha256 !== item.sha256) blockers.push(`${label} 实际 SHA-256 不一致`);
    } catch (error) {
      blockers.push(`${label} 实际产物不可读：${errorMessage(error)}`);
    }
  }
  return {
    summary: {
      ref: expected.ref,
      manifestDigest: `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`,
      items,
    },
    blockers,
  };
}

export async function inspectOfflineSeams(root, requiredIds = ENGINEERING_CHECKS) {
  const result = {};
  for (const [name, anchors] of Object.entries(OFFLINE_SEAM_ANCHORS)) {
    result[name] = true;
    for (const [file, includes] of anchors) {
      try {
        const content = await readFile(path.join(root, file), "utf8");
        if (!content.includes(includes)) result[name] = false;
      } catch {
        result[name] = false;
      }
    }
  }
  result.localRefs = {};
  for (const id of requiredIds) {
    const refs = LOCAL_REFS[id];
    if (!refs) continue;
    result.localRefs[id] = true;
    for (const file of refs) {
      try {
        await readFile(path.join(root, file));
      } catch {
        result.localRefs[id] = false;
      }
    }
  }
  return result;
}

function requiredCheckIds(stage) {
  if (stage === "engineering") return ENGINEERING_CHECKS;
  const maximum = stage === "candidate" ? 20 : stage === "release" ? 21 : 22;
  return new Set(P0_CHECKS.slice(0, maximum).map((check) => check.id));
}

function localCheckBlocker(id, stage, suites) {
  if (LOCAL_REFS[id] && suites?.localRefs?.[id] !== true) return "本地证据引用不存在";
  if (id === "P0-19" && stage !== "engineering" && suites?.tty !== true) {
    return "双平台真实 TTY seam 未通过";
  }
  if (!LOCAL_CHECKS.has(id)) return null;
  if (stage === "engineering") {
    if (suites?.engineering !== true) return "快速工程测试 seam 未通过";
  } else if (suites?.rc !== true) return "RC 验收 seam 未通过";
  if (id === "P0-12" && suites.entryEquivalence !== true) return "四入口等价 seam 未通过";
  if (["P0-10", "P0-11", "P0-13"].includes(id) && suites.runtimeWorkerFaults !== true) {
    return "Runtime/Worker 故障 seam 未通过";
  }
  if (id === "P0-18" && suites.version !== true) return "目标版本或发布元数据不一致";
  return null;
}

function validateEvidence(evidence, expected) {
  const id = typeof evidence?.checkId === "string" ? evidence.checkId : "未知验收项";
  const blockers = [];
  if (!P0_CHECKS.some((check) => check.id === id)) return [`${id} 不是有效 P0 验收项`];
  if (evidence.status !== "passed") blockers.push(`${id} 证据状态不是 passed`);
  if (!EVIDENCE_LEVELS.has(evidence.evidenceLevel)) blockers.push(`${id} 证据级别无效`);
  const expectedLevels = LOCAL_CHECKS.has(id)
    ? ["offline"]
    : (EXTERNAL_REQUIREMENTS[id] ?? []).map((requirement) => requirement.level);
  if (!expectedLevels.includes(evidence.evidenceLevel)) {
    blockers.push(`${id} 证据级别 ${String(evidence.evidenceLevel)} 不能用于此项`);
  }
  if (evidence.version !== expected.targetVersion) blockers.push(`${id} 证据版本不一致`);
  if (evidence.commit !== expected.commit) blockers.push(`${id} 证据提交不一致`);
  if (["offline", "dual-platform", "live-provider"].includes(evidence.evidenceLevel)) {
    if (evidence.runtimeDigest !== expected.runtimeDigest)
      blockers.push(`${id} Runtime 摘要不一致`);
  } else if (evidence.runtimeDigest && evidence.runtimeDigest !== expected.runtimeDigest) {
    blockers.push(`${id} Runtime 摘要不一致`);
  }
  if (
    ["candidate-package", "public-release", "public-reinstall"].includes(evidence.evidenceLevel)
  ) {
    if (evidence.artifactManifestDigest !== expected.artifacts?.manifestDigest) {
      blockers.push(`${id} 产物 manifest 摘要不一致`);
    }
  } else if (
    evidence.artifactManifestDigest &&
    evidence.artifactManifestDigest !== expected.artifacts?.manifestDigest
  ) {
    blockers.push(`${id} 产物 manifest 摘要不一致`);
  }
  if (typeof evidence.ref !== "string" || evidence.ref.trim().length === 0) {
    blockers.push(`${id} 证据引用为空`);
  }
  if (typeof evidence.sourceRef !== "string" || evidence.sourceRef.trim().length === 0) {
    blockers.push(`${id} 证据源文件引用为空`);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(evidence.sourceDigest)) {
    blockers.push(`${id} 证据源文件摘要无效`);
  }
  if (typeof evidence.generatedAt !== "string" || Number.isNaN(Date.parse(evidence.generatedAt))) {
    blockers.push(`${id} 证据生成时间无效`);
  }
  return blockers;
}

function validateReportTarget(input) {
  const blockers = [];
  if (input.targetVersion !== P0_TARGET_VERSION) blockers.push("P0 目标版本必须为 0.7.0");
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) blockers.push("目标提交必须是 40 位 Git SHA");
  if (input.sourceClean !== true) blockers.push("验收源代码必须是干净的 Git 提交");
  if (!/^sha256:[0-9a-f]{64}$/u.test(input.runtimeDigest)) {
    blockers.push("Runtime 摘要必须使用 sha256:<64 位小写十六进制>");
  }
  if (input.stage !== "engineering") {
    if (!input.artifacts) blockers.push(`${input.stage} 阶段缺少候选产物 manifest`);
    else {
      if (!/^sha256:[0-9a-f]{64}$/u.test(input.artifacts.manifestDigest)) {
        blockers.push("候选产物 manifest 摘要无效");
      }
      if (!Array.isArray(input.artifacts.items) || input.artifacts.items.length === 0) {
        blockers.push("候选产物 manifest 没有可审计产物");
      }
    }
  }
  return blockers;
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validateArtifactItem(item, index, expected, blockers, artifactPaths) {
  const label = `候选产物 manifest artifacts[${index}]`;
  if (typeof item?.path !== "string" || item.path.trim().length === 0) {
    blockers.push(`${label}.path 为空`);
  } else {
    const normalizedPath = item.path.replaceAll("\\", "/");
    if (artifactPaths.has(normalizedPath)) blockers.push(`${label}.path 重复`);
    artifactPaths.add(normalizedPath);
    if (item.kind === "npm" && !normalizedPath.endsWith(".tgz")) {
      blockers.push(`${label} npm 产物必须是 .tgz`);
    }
    if (item.kind === "python" && !normalizedPath.endsWith(".whl")) {
      blockers.push(`${label} python 产物必须是 .whl`);
    }
  }
  if (!["npm", "python", "source"].includes(item?.kind)) blockers.push(`${label}.kind 无效`);
  if (typeof item?.name !== "string" || item.name.trim().length === 0) {
    blockers.push(`${label}.name 为空`);
  }
  if (item?.version !== expected.targetVersion) blockers.push(`${label}.version 不一致`);
  if (!Number.isInteger(item?.size) || item.size < 0) blockers.push(`${label}.size 无效`);
  if (!/^[0-9a-f]{64}$/u.test(item?.sha256)) blockers.push(`${label}.sha256 无效`);
  return {
    path: item?.path ?? null,
    kind: item?.kind ?? null,
    name: item?.name ?? null,
    version: item?.version ?? null,
    size: item?.size ?? null,
    sha256: item?.sha256 ?? null,
  };
}

function isPassed(check) {
  return check.status === "passed";
}

export async function loadEvidenceFiles(root, files) {
  const evidence = [];
  const blockers = [];
  const evidenceRoot = await realpath(root);
  for (const file of files) {
    try {
      const requestedPath = path.resolve(evidenceRoot, file);
      if (!isPathInside(evidenceRoot, requestedPath)) throw new Error("路径越出工作区");
      const evidencePath = await realpath(requestedPath);
      if (!isPathInside(evidenceRoot, evidencePath)) throw new Error("真实路径越出工作区");
      const raw = await readFile(evidencePath, "utf8");
      const parsed = JSON.parse(raw);
      const source = {
        sourceRef: path.relative(evidenceRoot, evidencePath).replaceAll("\\", "/"),
        sourceDigest: `sha256:${createHash("sha256").update(raw, "utf8").digest("hex")}`,
      };
      const items = Array.isArray(parsed) ? parsed : [parsed];
      evidence.push(...items.map((item) => ({ ...item, ...source })));
    } catch (error) {
      blockers.push(`证据文件不可读：${file}：${errorMessage(error)}`);
    }
  }
  return { evidence, blockers };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function runCommand(root, plan) {
  const executable =
    plan.command === "npm" && process.platform === "win32"
      ? "npm.cmd"
      : plan.command === "python" && process.platform === "win32"
        ? "python.exe"
        : plan.command;
  return spawnSync(executable, plan.args, {
    cwd: root,
    shell: process.platform === "win32" && plan.command === "npm",
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
}

function gitIdentity(root) {
  const completed = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  const commit = completed.stdout.trim();
  if (completed.status !== 0 || !/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("无法解析当前 40 位 Git commit");
  }
  return { commit, clean: gitWorkingTreeClean(root) };
}

function gitWorkingTreeClean(root) {
  const completed = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  return completed.status === 0 && completed.stdout.trim().length === 0;
}

export function validateStableSourceIdentity(initial, current) {
  const blockers = [];
  if (initial.commit !== current.commit) blockers.push("验收期间 Git HEAD 发生变化");
  if (initial.clean && !current.clean) blockers.push("验收命令改变了 Git 工作区");
  return blockers;
}

function commandStep(name, command, args) {
  return { name, command, args };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseP0Arguments(process.argv.slice(2));
    const { report, output } = await runP0Acceptance(options);
    console.log(report.passed ? "P0 顶层验收通过" : "P0 顶层验收失败");
    console.log(`证据：${path.relative(repositoryRoot, output)}`);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
