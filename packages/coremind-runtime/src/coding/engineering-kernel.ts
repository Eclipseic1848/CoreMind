import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LoopConfig } from "coremind-config";

export type CodingLanguage = "typescript" | "javascript" | "python";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type CodingKernelErrorCode =
  | "coding_choice_required"
  | "coding_invalid_choice"
  | "coding_invalid_change"
  | "coding_verification_claim_mismatch"
  | "coding_delivery_not_verified";

export class CodingKernelError extends Error {
  constructor(
    readonly code: CodingKernelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodingKernelError";
  }
}

export interface LanguageCandidate {
  language: CodingLanguage;
  score: number;
  evidence: string[];
}

export interface CodingRepositoryInspection {
  root: string;
  languageCandidates: LanguageCandidate[];
  recommendedLanguage?: CodingLanguage;
  packageManagers: PackageManager[];
  testCommands: string[];
  files: string[];
  requiresUserChoice: boolean;
  /** 探测结果只是建议；只有 selectCodingEnvironment 才形成选择。 */
  selection?: never;
}

export interface CodingEnvironmentSelection {
  language: CodingLanguage;
  packageManager?: PackageManager;
  testCommand: string;
  source: { language: "user" | "detected"; packageManager: "user" | "detected" | "none" };
}

export interface CodingEnvironmentChoice {
  language?: CodingLanguage;
  packageManager?: PackageManager;
  testCommand?: string;
}

export interface RepositoryMapEntry {
  path: string;
  kind: "manifest" | "source" | "test" | "documentation" | "configuration" | "other";
  language?: CodingLanguage;
}

export interface RepositoryMap {
  root: string;
  language: CodingLanguage;
  packageManager?: PackageManager;
  testCommand: string;
  entries: RepositoryMapEntry[];
}

export type EngineeringPhaseId = "understand" | "plan" | "modify" | "verify" | "repair" | "deliver";

export interface EngineeringTaskPlan {
  task: string;
  acceptanceCriteria: string[];
  selection: CodingEnvironmentSelection;
  phases: Array<{
    id: EngineeringPhaseId;
    objective: string;
    allowedTools: CodingToolId[];
    requiredEvidence: string[];
  }>;
}

export type CodingToolId =
  | "read"
  | "grep"
  | "find"
  | "edit"
  | "write"
  | "bash"
  | "git_status"
  | "git_diff"
  | "git_log";

export interface CodingToolContract {
  id: CodingToolId;
  purpose: string;
  phases: EngineeringPhaseId[];
  mutates: boolean;
  requiresCheckpoint: boolean;
  highRisk: boolean;
}

export const CODING_TOOL_CONTRACTS: readonly CodingToolContract[] = [
  {
    id: "read",
    purpose: "读取已定位的仓库文件",
    phases: ["understand", "plan", "repair"],
    mutates: false,
    requiresCheckpoint: false,
    highRisk: false,
  },
  {
    id: "grep",
    purpose: "按内容搜索符号和调用关系",
    phases: ["understand", "plan", "repair"],
    mutates: false,
    requiresCheckpoint: false,
    highRisk: false,
  },
  {
    id: "find",
    purpose: "按路径和文件名建立仓库视图",
    phases: ["understand", "plan"],
    mutates: false,
    requiresCheckpoint: false,
    highRisk: false,
  },
  {
    id: "edit",
    purpose: "对已存在文件做最小精确修改",
    phases: ["modify", "repair"],
    mutates: true,
    requiresCheckpoint: true,
    highRisk: false,
  },
  {
    id: "write",
    purpose: "创建或完整替换任务范围内的文件",
    phases: ["modify", "repair"],
    mutates: true,
    requiresCheckpoint: true,
    highRisk: false,
  },
  {
    id: "bash",
    purpose: "执行明确的复现、构建和测试命令",
    phases: ["understand", "verify", "repair"],
    mutates: true,
    requiresCheckpoint: false,
    highRisk: true,
  },
  {
    id: "git_status",
    purpose: "读取工作区变更边界",
    phases: ["understand", "verify", "deliver"],
    mutates: false,
    requiresCheckpoint: false,
    highRisk: false,
  },
  {
    id: "git_diff",
    purpose: "审查实际变更与任务计划是否一致",
    phases: ["verify", "deliver"],
    mutates: false,
    requiresCheckpoint: false,
    highRisk: false,
  },
  {
    id: "git_log",
    purpose: "读取必要的历史上下文",
    phases: ["understand", "deliver"],
    mutates: false,
    requiresCheckpoint: false,
    highRisk: false,
  },
] as const;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".coremind",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

/** 只读且有界地探测仓库；结果是建议，不会替用户选择语言或命令。 */
export async function inspectCodingRepository(
  repositoryRoot: string,
  options: { maxFiles?: number } = {},
): Promise<CodingRepositoryInspection> {
  const root = path.resolve(repositoryRoot);
  const maxFiles = options.maxFiles ?? 2_000;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new CodingKernelError("coding_invalid_choice", "maxFiles 必须是正整数");
  }
  const files = await collectFiles(root, maxFiles);
  const fileSet = new Set(files);
  const packageJson = await readPackageJson(root, fileSet);
  const languageCandidates = detectLanguages(files, fileSet);
  const packageManagers = detectPackageManagers(fileSet, packageJson !== undefined);
  const testCommands = await detectTestCommands(root, fileSet, packageJson, packageManagers);
  const recommendedLanguage = languageCandidates[0]?.language;
  const requiresUserChoice =
    languageCandidates.length !== 1 || packageManagers.length > 1 || testCommands.length === 0;
  return {
    root,
    languageCandidates,
    recommendedLanguage,
    packageManagers,
    testCommands,
    files,
    requiresUserChoice,
  };
}

export async function selectCodingEnvironment(
  inspection: CodingRepositoryInspection,
  choice: CodingEnvironmentChoice,
): Promise<CodingEnvironmentSelection> {
  const detectedLanguages = inspection.languageCandidates.map((candidate) => candidate.language);
  const language =
    choice.language ?? (detectedLanguages.length === 1 ? detectedLanguages[0] : undefined);
  if (!language) {
    throw new CodingKernelError(
      "coding_choice_required",
      "工程语言存在歧义；请选择 typescript、javascript 或 python",
    );
  }
  if (!(["typescript", "javascript", "python"] as const).includes(language)) {
    throw new CodingKernelError("coding_invalid_choice", `不支持的工程语言：${language}`);
  }

  const nodeProject = language === "typescript" || language === "javascript";
  let packageManager = choice.packageManager;
  if (nodeProject && !packageManager) {
    if (inspection.packageManagers.length > 1) {
      throw new CodingKernelError("coding_choice_required", "检测到多个包管理器；请明确选择");
    }
    packageManager = inspection.packageManagers[0] ?? "npm";
  }
  if (packageManager && !inspection.packageManagers.includes(packageManager)) {
    if (inspection.packageManagers.length > 0) {
      throw new CodingKernelError(
        "coding_invalid_choice",
        `所选包管理器 ${packageManager} 与仓库证据不一致`,
      );
    }
  }

  const candidates = testCommandsForLanguage(inspection.testCommands, language);
  const testCommand = choice.testCommand ?? candidates[0];
  if (!testCommand) {
    throw new CodingKernelError("coding_choice_required", "无法确定测试命令；请由用户明确提供");
  }
  return {
    language,
    ...(nodeProject && packageManager ? { packageManager } : {}),
    testCommand,
    source: {
      language: choice.language ? "user" : "detected",
      packageManager: nodeProject ? (choice.packageManager ? "user" : "detected") : "none",
    },
  };
}

export function buildRepositoryMap(
  inspection: CodingRepositoryInspection,
  selection: CodingEnvironmentSelection,
): RepositoryMap {
  return {
    root: inspection.root,
    language: selection.language,
    packageManager: selection.packageManager,
    testCommand: selection.testCommand,
    entries: inspection.files.map((file) => ({
      path: file,
      kind: classifyRepositoryEntry(file),
      ...languageForFile(file),
    })),
  };
}

export function createEngineeringTaskPlan(input: {
  task: string;
  acceptanceCriteria: string[];
  selection: CodingEnvironmentSelection;
}): EngineeringTaskPlan {
  if (!input.task.trim()) {
    throw new CodingKernelError("coding_invalid_choice", "编码任务不能为空");
  }
  if (
    input.acceptanceCriteria.length === 0 ||
    input.acceptanceCriteria.some((item) => !item.trim())
  ) {
    throw new CodingKernelError("coding_invalid_choice", "至少需要一条明确验收条件");
  }
  return {
    task: input.task.trim(),
    acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()),
    selection: input.selection,
    phases: [
      phase(
        "understand",
        "读取仓库、复现问题并建立证据边界",
        ["read", "grep", "find", "bash", "git_status", "git_log"],
        ["repo-map", "failing-reproduction"],
      ),
      phase(
        "plan",
        "形成最小变更计划和验证命令",
        ["read", "grep", "find"],
        ["task-plan", "accepted-files"],
      ),
      phase(
        "modify",
        "在 checkpoint 后实施最小修改",
        ["edit", "write"],
        ["checkpoint", "change-set"],
      ),
      phase(
        "verify",
        "运行目标测试、回归测试并审查 Diff",
        ["bash", "git_status", "git_diff"],
        ["target-test", "regression-test", "diff-review"],
      ),
      phase(
        "repair",
        "只根据失败证据执行有界修复",
        ["read", "grep", "edit", "write", "bash"],
        ["failure-evidence", "repair-diff"],
      ),
      phase(
        "deliver",
        "汇总实际变更、验证和未解决风险",
        ["git_status", "git_diff", "git_log"],
        ["delivery-summary"],
      ),
    ],
  };
}

export function createEngineeringKernelDefinition(options: {
  selection: CodingEnvironmentSelection;
  agents?: { planner?: string; coder?: string; verifier?: string };
  maxIterations?: number;
  maxRepairs?: number;
  maxRepeatedAction?: number;
}): {
  loop: LoopConfig;
  requiredTools: CodingToolId[];
  excludedCapabilities: string[];
  selection: CodingEnvironmentSelection;
} {
  const planner = options.agents?.planner ?? "main";
  const coder = options.agents?.coder ?? "main";
  const verifier = options.agents?.verifier ?? "main";
  return {
    selection: options.selection,
    requiredTools: CODING_TOOL_CONTRACTS.map((tool) => tool.id),
    excludedCapabilities: [
      "browser-automation",
      "desktop-control",
      "lsp-cluster",
      "worktree-orchestration",
      "extension-marketplace",
    ],
    loop: {
      planning: {
        agent: planner,
        input: "理解 {{prompt}}，输出最小变更计划、目标文件和验证命令。",
      },
      execute: {
        agent: coder,
        input: "按 {{planning.text}} 实施受控修改；所有写入必须经过权限与 checkpoint。",
      },
      verify: {
        agent: verifier,
        input: `验证 {{candidate.text}}；必须运行目标测试和 ${options.selection.testCommand}，审查 Git Diff。仅在全部证据通过时输出 PASS。`,
        passIf: "{{text}} == PASS",
        evidence: {
          mode: "runtime",
          regressionCommand: options.selection.testCommand,
          minSuccessfulTestCommands: 2,
          requireCheckpoint: true,
          requireDiffReview: true,
        },
      },
      repair: {
        agent: coder,
        input: "根据 {{verification.text}} 的失败证据做最小修复，不重复无进展动作。",
      },
      maxIterations: options.maxIterations ?? 3,
      maxRepairs: options.maxRepairs ?? 2,
      maxRepeatedAction: options.maxRepeatedAction ?? 2,
      onFailure: "repair",
      onExhausted: "fail",
    },
  };
}

export interface EngineeringChange {
  path: string;
  reason: string;
  checkpointId: string;
  diff: string;
}

export interface EngineeringVerification {
  kind: "reproduction" | "target-test" | "regression-test" | "build" | "lint";
  command: string;
  exitCode: number | null;
  durationMs: number;
  artifactRef?: string;
  status: "passed" | "failed" | "aborted";
}

export interface EngineeringControlEvent {
  type: "approval-denied" | "aborted" | "budget-exceeded" | "no-progress";
  detail: string;
}

export interface EngineeringDeliverySummary {
  task: string;
  outcome: "succeeded" | "paused" | "failed" | "aborted";
  testsPassed: boolean;
  changedFiles: string[];
  changes: EngineeringChange[];
  verification: EngineeringVerification[];
  controlEvents: EngineeringControlEvent[];
  diffReviewed: boolean;
  planToolConsistency: {
    plannedTools: CodingToolId[];
    actualTools: string[];
    unplannedTools: string[];
  };
}

/**
 * @deprecated 仅用于导入旧版外部证据。新代码应使用 createEngineeringKernelDefinition，
 * 由 Runtime Trace 的 engineering_evidence 事件作为成功判定来源。
 */
export class EngineeringEvidenceLedger {
  private readonly changes: EngineeringChange[] = [];
  private readonly verification: EngineeringVerification[] = [];
  private readonly toolCalls: string[] = [];
  private readonly controlEvents: EngineeringControlEvent[] = [];
  private diffReviewed = false;

  constructor(private readonly input: { plan: EngineeringTaskPlan; repoMap: RepositoryMap }) {}

  recordToolCall(tool: string): void {
    this.toolCalls.push(tool);
  }

  recordChange(change: EngineeringChange): void {
    if (
      !isSafeRelativePath(change.path) ||
      !change.reason.trim() ||
      !change.checkpointId.trim() ||
      !change.diff.trim()
    ) {
      throw new CodingKernelError(
        "coding_invalid_change",
        "每个变更必须包含工作区相对路径、原因、写前 checkpoint 和 Diff",
      );
    }
    this.changes.push({ ...change, path: toPortablePath(change.path) });
  }

  recordVerification(
    evidence: Omit<EngineeringVerification, "status"> & { aborted?: boolean },
  ): void {
    if (!evidence.command.trim() || evidence.durationMs < 0) {
      throw new CodingKernelError("coding_invalid_change", "验证证据必须包含命令和非负耗时");
    }
    const status = evidence.aborted ? "aborted" : evidence.exitCode === 0 ? "passed" : "failed";
    const { aborted: _aborted, ...record } = evidence;
    this.verification.push({ ...record, status });
  }

  recordControlEvent(event: EngineeringControlEvent): void {
    this.controlEvents.push({ ...event });
  }

  markDiffReviewed(): void {
    this.diffReviewed = true;
  }

  finalize(input: {
    claimTestsPassed: boolean;
    outcome: EngineeringDeliverySummary["outcome"];
  }): EngineeringDeliverySummary {
    const targetPassed = this.verification.some(
      (item) => item.kind === "target-test" && item.status === "passed",
    );
    const regressionPassed = this.verification.some(
      (item) => item.kind === "regression-test" && item.status === "passed",
    );
    const testsPassed = targetPassed && regressionPassed;
    if (input.claimTestsPassed && !testsPassed) {
      throw new CodingKernelError(
        "coding_verification_claim_mismatch",
        "没有目标测试与回归测试的成功证据，不能声明测试通过",
      );
    }
    const blocked = this.controlEvents.some((event) =>
      ["approval-denied", "aborted", "budget-exceeded", "no-progress"].includes(event.type),
    );
    if (
      input.outcome === "succeeded" &&
      (!testsPassed || !this.diffReviewed || this.changes.length === 0 || blocked)
    ) {
      throw new CodingKernelError(
        "coding_delivery_not_verified",
        "成功交付必须同时具备变更、目标测试、回归测试、Diff 审查且没有控制面阻断",
      );
    }
    const plannedTools = [
      ...new Set(this.input.plan.phases.flatMap((phase) => phase.allowedTools)),
    ];
    const actualTools = [...this.toolCalls];
    return {
      task: this.input.plan.task,
      outcome: input.outcome,
      testsPassed,
      changedFiles: [...new Set(this.changes.map((change) => change.path))].sort(),
      changes: [...this.changes],
      verification: [...this.verification],
      controlEvents: [...this.controlEvents],
      diffReviewed: this.diffReviewed,
      planToolConsistency: {
        plannedTools,
        actualTools,
        unplannedTools: [
          ...new Set(actualTools.filter((tool) => !plannedTools.includes(tool as CodingToolId))),
        ],
      },
    };
  }
}

function phase(
  id: EngineeringPhaseId,
  objective: string,
  allowedTools: CodingToolId[],
  requiredEvidence: string[],
): EngineeringTaskPlan["phases"][number] {
  return { id, objective, allowedTools, requiredEvidence };
}

async function collectFiles(root: string, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }
      if (entry.isFile()) {
        files.push(toPortablePath(path.relative(root, path.join(directory, entry.name))));
      }
    }
  };
  await visit(root);
  return files;
}

async function readPackageJson(
  root: string,
  files: Set<string>,
): Promise<{ scripts?: Record<string, string> } | undefined> {
  if (!files.has("package.json")) return undefined;
  try {
    return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
  } catch {
    return undefined;
  }
}

function detectLanguages(files: string[], fileSet: Set<string>): LanguageCandidate[] {
  const typescriptFiles = files.filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file));
  const javascriptFiles = files.filter((file) => /\.(?:js|jsx|mjs|cjs)$/.test(file));
  const pythonFiles = files.filter((file) => /\.py$/.test(file));
  const candidates: LanguageCandidate[] = [];
  if (fileSet.has("tsconfig.json") || typescriptFiles.length > 0) {
    candidates.push({
      language: "typescript",
      score: (fileSet.has("tsconfig.json") ? 20 : 0) + typescriptFiles.length,
      evidence: [
        ...(fileSet.has("tsconfig.json") ? ["tsconfig.json"] : []),
        ...typescriptFiles.slice(0, 5),
      ],
    });
  } else if (fileSet.has("package.json") || javascriptFiles.length > 0) {
    candidates.push({
      language: "javascript",
      score: (fileSet.has("package.json") ? 10 : 0) + javascriptFiles.length,
      evidence: [
        ...(fileSet.has("package.json") ? ["package.json"] : []),
        ...javascriptFiles.slice(0, 5),
      ],
    });
  }
  if (fileSet.has("pyproject.toml") || fileSet.has("requirements.txt") || pythonFiles.length > 0) {
    candidates.push({
      language: "python",
      score:
        (fileSet.has("pyproject.toml") ? 20 : 0) +
        (fileSet.has("requirements.txt") ? 10 : 0) +
        pythonFiles.length,
      evidence: [
        ...(fileSet.has("pyproject.toml") ? ["pyproject.toml"] : []),
        ...(fileSet.has("requirements.txt") ? ["requirements.txt"] : []),
        ...pythonFiles.slice(0, 5),
      ],
    });
  }
  return candidates.sort(
    (left, right) => right.score - left.score || left.language.localeCompare(right.language, "en"),
  );
}

function detectPackageManagers(files: Set<string>, hasPackageJson: boolean): PackageManager[] {
  const managers: PackageManager[] = [];
  if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) managers.push("npm");
  if (files.has("pnpm-lock.yaml")) managers.push("pnpm");
  if (files.has("yarn.lock")) managers.push("yarn");
  if (files.has("bun.lock") || files.has("bun.lockb")) managers.push("bun");
  if (managers.length === 0 && hasPackageJson) managers.push("npm");
  return managers;
}

async function detectTestCommands(
  root: string,
  files: Set<string>,
  packageJson: { scripts?: Record<string, string> } | undefined,
  managers: PackageManager[],
): Promise<string[]> {
  const commands: string[] = [];
  if (packageJson?.scripts?.test) {
    for (const manager of managers.length > 0 ? managers : ["npm" as const]) {
      commands.push(manager === "npm" ? "npm test" : `${manager} test`);
    }
  } else if (packageJson) {
    commands.push("node --test");
  }
  const hasPython = [...files].some((file) => file.endsWith(".py"));
  if (hasPython || files.has("pyproject.toml") || files.has("requirements.txt")) {
    const hasPytest =
      files.has("pytest.ini") ||
      files.has("conftest.py") ||
      files.has("tox.ini") ||
      (await fileMentions(root, files, "pyproject.toml", "pytest")) ||
      (await fileMentions(root, files, "requirements.txt", "pytest"));
    commands.push(hasPytest ? "python -m pytest" : "python -m unittest discover -s tests");
  }
  return [...new Set(commands)];
}

async function fileMentions(
  root: string,
  files: Set<string>,
  relative: string,
  token: string,
): Promise<boolean> {
  if (!files.has(relative)) return false;
  try {
    const content = await readFile(path.join(root, relative), "utf8");
    return content.toLowerCase().includes(token.toLowerCase());
  } catch {
    return false;
  }
}

function testCommandsForLanguage(commands: string[], language: CodingLanguage): string[] {
  return language === "python"
    ? commands.filter((command) => command.startsWith("python "))
    : commands.filter((command) => !command.startsWith("python "));
}

function classifyRepositoryEntry(file: string): RepositoryMapEntry["kind"] {
  const basename = path.posix.basename(file);
  if (
    [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
      "pyproject.toml",
      "requirements.txt",
    ].includes(basename)
  ) {
    return "manifest";
  }
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|(?:\.test|\.spec)\.[^.]+$/.test(file)) return "test";
  if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/.test(file)) return "source";
  if (/\.(?:md|mdx|rst|txt)$/.test(file)) return "documentation";
  if (/\.(?:json|ya?ml|toml|ini)$/.test(file)) return "configuration";
  return "other";
}

function languageForFile(file: string): { language?: CodingLanguage } {
  if (/\.(?:ts|tsx|mts|cts)$/.test(file)) return { language: "typescript" };
  if (/\.(?:js|jsx|mjs|cjs)$/.test(file)) return { language: "javascript" };
  if (/\.py$/.test(file)) return { language: "python" };
  return {};
}

function isSafeRelativePath(value: string): boolean {
  if (!value.trim() || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}
