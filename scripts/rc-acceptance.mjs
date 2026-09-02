import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const TTY_CHECKS = [
  "launch",
  "help",
  "approval-deny",
  "approval-allow",
  "abort",
  "session-resume",
  "checkpoint-diff-restore",
  "streaming",
  "status",
  "exit",
];

export const TTY_EVIDENCE_RELATIVE_DIRECTORY = path.join(".scratch", "rc-evidence");

export const RC_CASES = [
  caseItem("P01", "普通问答与完整终态", ["node", "python"], allEntries(), [
    anchor("packages/coremind-runtime/src/runtime.test.ts", "成功运行返回分离的结果"),
    anchor(
      "python/tests/test_node_parity.py",
      "test_typescript_and_python_share_outcome_and_event_contract",
    ),
  ]),
  caseItem("P02", "多工具结果回灌", ["node", "python"], allEntries(), [
    anchor(
      "packages/coremind-runtime/src/agent-factory.test.ts",
      "连续两次工具调用的结果都回灌后再结束",
    ),
    anchor(
      "packages/coremind-protocol/src/protocol.test.ts",
      "支持 Python callable 注册和工具结果回传",
    ),
  ]),
  caseItem("P03", "工具拒绝且零副作用", ["node", "python"], allEntries(), [
    anchor(
      "packages/coremind-runtime/src/runtime.test.ts",
      "ask 模式全部工具请求被拒绝时返回暂停而不是成功",
    ),
    anchor(
      "packages/coremind-runtime/src/runtime.test.ts",
      "人工拒绝第一次工具审批后立即停止，不再次请求模型或审批",
    ),
    anchor(
      "packages/coremind-runtime/src/runtime.test.ts",
      "同批次先允许后拒绝时在批次结束后停止，不再请求模型",
    ),
    anchor(
      "packages/coremind-runtime/src/runtime.test.ts",
      "工作流步骤的工具审批被拒绝后立即暂停，不执行后续步骤",
    ),
  ]),
  caseItem("P04", "部分成功不能覆盖拒绝", ["node"], allEntries(), [
    anchor(
      "packages/coremind-runtime/src/run-terminalizer.test.ts",
      "既有成功工具结果又有权限拒绝时仍返回 paused",
    ),
  ]),
  caseItem("P05", "路径逃逸失败关闭", ["node"], runtimeEntries(), [
    anchor(
      "packages/coremind-runtime/src/tool-policy.test.ts",
      "拒绝绝对路径与指向工作区外的目录链接",
    ),
  ]),
  caseItem("P06", "网络拒绝不能绕过", ["node"], runtimeEntries(), [
    anchor("packages/coremind-runtime/src/tool-policy.test.ts", "network deny 拒绝嵌套 URL"),
  ]),
  caseItem(
    "P07",
    "审批目标与风险完整展示",
    ["node"],
    ["tui", "headless-cli"],
    [anchor("packages/coremind-cli/src/tui.test.tsx", "长参数不会遮住审批目标与副作用")],
  ),
  caseItem("P08", "中止与超时终态一致", ["node", "python"], allEntries(), [
    anchor("packages/coremind-runtime/src/runtime.test.ts", "外部中止会传播到 Loop"),
    anchor("packages/coremind-cli/src/tui.test.tsx", "忙碌生成期间输入 /abort 会中止当前回答"),
  ]),
  caseItem("P09", "checkpoint 冲突不覆盖人工修改", ["node", "python"], allEntries(), [
    anchor("packages/coremind-runtime/src/checkpoint.test.ts", "工具完成后文件又被修改时拒绝恢复"),
    anchor("python/tests/test_client.py", "test_run_state_and_checkpoint_protocol_methods"),
  ]),
  caseItem("P10", "Session 与 RunState 稳定恢复", ["node", "python"], allEntries(), [
    anchor("packages/coremind-runtime/src/run-state.test.ts", "从稳定步骤输出构造恢复计划"),
    anchor(
      "python/tests/test_node_parity.py",
      "test_loop_states_and_terminal_result_match_typescript",
    ),
  ]),
  caseItem("P11", "retry 耗尽不返回成功", ["node"], allEntries(), [
    anchor("packages/coremind-runtime/src/orchestrator.test.ts", "retry：耗尽后拒绝已知不合格输出"),
  ]),
  caseItem("P12", "verify-repair-verify 有界收敛", ["node", "python"], allEntries(), [
    anchor(
      "packages/coremind-runtime/src/loop-runner.test.ts",
      "执行、验证失败、修复、再次验证通过后才成功",
    ),
  ]),
  caseItem("P13", "无进展达到阈值后停止", ["node"], runtimeEntries(), [
    anchor(
      "packages/coremind-runtime/src/loop-controller.test.ts",
      "相同动作达到阈值时按耗尽策略暂停",
    ),
  ]),
  caseItem(
    "P14",
    "TypeScript 真实缺陷最小修复",
    ["node"],
    ["headless-cli", "typescript-sdk"],
    [
      anchor(
        "examples/coding-evals/coding-evals.test.ts",
        "TypeScript Agent 先复现失败，再最小修复",
      ),
    ],
  ),
  caseItem(
    "P15",
    "Python 真实缺陷最小修复",
    ["node", "python"],
    ["headless-cli", "python-sdk"],
    [anchor("examples/coding-evals/coding-evals.test.ts", "Python Agent 先复现失败，再最小修复")],
  ),
  caseItem("P16", "既有脏工作区保持不变", ["node"], runtimeEntries(), [
    anchor("examples/coding-evals/coding-evals.test.ts", "用户自己的未提交草稿，必须原样保留"),
  ]),
  caseItem("P17", "敏感信息不进入记录", ["node", "python"], allEntries(), [
    anchor("packages/coremind-runtime/src/trace.test.ts", "持久化和转发前隐藏凭据、正文与命令"),
    anchor("packages/coremind-tools/src/linux-sandbox.test.ts", "只允许写工作区并拒绝常见凭据"),
  ]),
  caseItem(
    "P18",
    "npm tarball 内容与入口",
    ["metadata", "artifacts"],
    ["artifact"],
    [
      anchor(
        "scripts/package-artifacts.test.ts",
        "拒绝测试、内部计划、运行状态、checkpoint、会话和环境文件",
      ),
    ],
  ),
  caseItem(
    "P19",
    "Python wheel 内容与 Worker",
    ["metadata", "artifacts"],
    ["artifact"],
    [
      anchor("python/tests/test_release_metadata.py", "test_public_version_matches_pyproject"),
      anchor("scripts/check-python-wheel.py", "wheel 干净安装与内置 Worker 冒烟通过"),
    ],
  ),
  {
    id: "P20",
    title: "Windows 与 Linux 真实伪终端",
    suites: [],
    entries: ["tui"],
    evidence: [],
    manual: true,
  },
];

export const RC_SUITES = [
  { name: "node", commands: [["npm", ["test"]]] },
  {
    name: "python",
    commands: [
      [
        "python",
        [
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
        ],
      ],
    ],
  },
  {
    name: "metadata",
    commands: [["npm", ["run", "release:preflight", "--", "--allow-dirty"]]],
  },
  {
    name: "artifacts",
    commands: [
      ["npm", ["run", "release:check-npm"]],
      ["npm", ["run", "release:test-npm"]],
      ["npm", ["run", "release:check-wheel"]],
    ],
  },
];

export function resolveRcSuites({
  deferProviderCertification = false,
  allowProviderNetworkWaiver = false,
} = {}) {
  if (deferProviderCertification && allowProviderNetworkWaiver) {
    throw new Error("Provider 认证延后与网络豁免不能同时启用");
  }
  if (!deferProviderCertification && !allowProviderNetworkWaiver) return RC_SUITES;
  const option = deferProviderCertification
    ? "--defer-provider-certification"
    : "--allow-provider-network-waiver";
  return RC_SUITES.map((suite) =>
    suite.name === "metadata"
      ? {
          ...suite,
          commands: suite.commands.map(([command, args]) => [command, [...args, option]]),
        }
      : suite,
  );
}

export function evaluateRcAcceptance({ suiteResults, evidenceResults, manualEvidence }) {
  const manualPlatforms = new Set(
    manualEvidence.filter((item) => item.passed === true).map((item) => item.platform),
  );
  const cases = RC_CASES.map((item) => {
    if (item.manual) {
      const passed = manualPlatforms.has("windows") && manualPlatforms.has("linux");
      return { ...item, status: passed ? "passed" : "pending_manual" };
    }
    const passed =
      item.suites.every((suite) => suiteResults[suite] === true) &&
      evidenceResults[item.id] === true;
    return { ...item, status: passed ? "passed" : "failed" };
  });
  const automatedReady = cases
    .filter((item) => !item.manual)
    .every((item) => item.status === "passed");
  return {
    automatedReady,
    ready: automatedReady && cases.every((item) => item.status === "passed"),
    cases,
  };
}

function caseItem(id, title, suites, entries, evidence) {
  return { id, title, suites, entries, evidence, manual: false };
}

function anchor(file, includes) {
  return { file, includes };
}

export async function verifyRcCaseEvidence(root) {
  const blockers = [];
  const results = {};
  const cache = new Map();
  for (const item of RC_CASES.filter((candidate) => !candidate.manual)) {
    let passed = item.evidence.length > 0;
    for (const evidence of item.evidence) {
      const file = path.join(root, evidence.file);
      let content = cache.get(file);
      if (content === undefined) {
        try {
          content = await readFile(file, "utf8");
          cache.set(file, content);
        } catch {
          content = null;
        }
      }
      if (typeof content !== "string" || !content.includes(evidence.includes)) {
        passed = false;
        blockers.push(`${item.id} 缺少测试证据：${evidence.file} -> ${evidence.includes}`);
      }
    }
    results[item.id] = passed;
  }
  return { results, blockers };
}

export function validateTtyEvidence(evidence, expected) {
  const blockers = [];
  if (!evidence || typeof evidence !== "object") return ["证据必须是 JSON 对象"];
  if (evidence.schemaVersion !== 1) blockers.push("schemaVersion 必须为 1");
  if (evidence.platform !== expected.platform) {
    blockers.push(`platform 应为 ${expected.platform}`);
  }
  if (evidence.version !== expected.version) blockers.push(`version 应为 ${expected.version}`);
  if (evidence.commit !== expected.commit) blockers.push(`commit 应为 ${expected.commit}`);
  if (evidence.passed !== true) blockers.push("passed 必须为 true");
  if (evidence.evidenceLevel !== "automated-real-tty") {
    blockers.push("evidenceLevel 必须为 automated-real-tty");
  }
  if (typeof evidence.terminal !== "string" || evidence.terminal.trim().length === 0) {
    blockers.push("terminal 不能为空");
  }
  if (typeof evidence.testedAt !== "string" || Number.isNaN(Date.parse(evidence.testedAt))) {
    blockers.push("testedAt 必须是有效 ISO 时间");
  }
  for (const check of TTY_CHECKS) {
    if (evidence.checks?.[check] !== true) blockers.push(`checks.${check} 必须为 true`);
  }
  return blockers;
}

function allEntries() {
  return ["tui", "headless-cli", "typescript-sdk", "python-sdk"];
}

function runtimeEntries() {
  return ["headless-cli", "typescript-sdk", "python-sdk"];
}

async function runAcceptance({
  requireManual,
  deferProviderCertification = false,
  allowProviderNetworkWaiver = false,
}) {
  const suiteResults = {};
  for (const suite of resolveRcSuites({
    deferProviderCertification,
    allowProviderNetworkWaiver,
  })) {
    suiteResults[suite.name] = suite.commands.every(([command, args]) => run(command, args));
    if (!suiteResults[suite.name]) break;
  }
  const commit = gitValue(["rev-parse", "HEAD"]);
  const rootManifest = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const manual = await loadManualEvidence({ commit, version: rootManifest.version });
  const evidenceVerification = await verifyRcCaseEvidence(repositoryRoot);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    commit,
    suiteResults,
    evidenceBlockers: evidenceVerification.blockers,
    manualEvidenceBlockers: manual.blockers,
    ...evaluateRcAcceptance({
      suiteResults,
      evidenceResults: evidenceVerification.results,
      manualEvidence: manual.evidence,
    }),
  };
  const outputDirectory = path.join(repositoryRoot, ".scratch");
  await mkdir(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, `rc-acceptance-${process.platform}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    report.automatedReady
      ? `RC 自动验收通过：P01～P19；P20 ${report.ready ? "已通过" : "等待双平台真实伪终端证据"}`
      : "RC 自动验收失败",
  );
  console.log(`证据：${path.relative(repositoryRoot, output)}`);
  if (!report.automatedReady || (requireManual && !report.ready)) process.exitCode = 1;
}

async function loadManualEvidence({ commit, version }) {
  const evidenceDirectory = path.join(repositoryRoot, TTY_EVIDENCE_RELATIVE_DIRECTORY);
  const files = ["rc-tty-windows.json", "rc-tty-linux.json"];
  const evidence = [];
  const blockers = [];
  for (const file of files) {
    const fullPath = path.join(evidenceDirectory, file);
    if (!existsSync(fullPath)) continue;
    const platform = file.includes("windows") ? "windows" : "linux";
    try {
      const item = JSON.parse(await readFile(fullPath, "utf8"));
      const itemBlockers = validateTtyEvidence(item, { platform, version, commit });
      if (itemBlockers.length === 0) evidence.push(item);
      else blockers.push(...itemBlockers.map((blocker) => `${file}: ${blocker}`));
    } catch (error) {
      blockers.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { evidence, blockers };
}

function run(command, args) {
  const executable =
    command === "npm" && process.platform === "win32"
      ? "npm.cmd"
      : command === "python" && process.platform === "win32"
        ? "python.exe"
        : command;
  const completed = spawnSync(executable, args, {
    cwd: repositoryRoot,
    shell: process.platform === "win32" && command === "npm",
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONPATH: [path.join(repositoryRoot, "python", "src"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
  });
  return completed.status === 0;
}

function gitValue(args) {
  const completed = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  return completed.status === 0 ? completed.stdout.trim() : "unknown";
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--verify-manual-only")) {
    const commit = gitValue(["rev-parse", "HEAD"]);
    const version = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    ).version;
    const manual = await loadManualEvidence({ commit, version });
    if (manual.evidence.length !== 2 || manual.blockers.length > 0) {
      throw new Error(`双平台真实伪终端证据无效：\n- ${manual.blockers.join("\n- ")}`);
    }
    console.log(`双平台真实伪终端证据通过：${version} · ${commit}`);
  } else {
    await runAcceptance({
      requireManual: process.argv.includes("--require-manual"),
      deferProviderCertification: process.argv.includes("--defer-provider-certification"),
      allowProviderNetworkWaiver: process.argv.includes("--allow-provider-network-waiver"),
    });
  }
}
