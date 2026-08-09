import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { GitAdapter, ProcessRunner } from "coremind-tools";
import type { RunStatus } from "./result.js";
import type { RunResult } from "./runtime.js";

interface GraderBase {
  id?: string;
}

export interface OutcomeGrader extends GraderBase {
  type: "outcome";
  status: RunStatus;
  finishReason?: string;
}

export interface TrajectoryStep {
  tool: string;
  argsContains?: string;
  result?: "succeeded" | "failed";
}

export interface TrajectoryGrader extends GraderBase {
  type: "trajectory";
  sequence: TrajectoryStep[];
  forbiddenTools?: string[];
  maxToolFailures?: number;
}

export interface CommandGrader extends GraderBase {
  type: "command";
  command: string;
  args?: string[];
  cwd?: string;
  exitCode?: number;
  stdoutContains?: string[];
  stdoutNotContains?: string[];
  stderrContains?: string[];
  stderrNotContains?: string[];
  timeoutMs?: number;
}

export interface FileGrader extends GraderBase {
  type: "file";
  path: string;
  exists?: boolean;
  equals?: string;
  contains?: string[];
  notContains?: string[];
  unchanged?: boolean;
  maxBytes?: number;
}

export interface DiffGrader extends GraderBase {
  type: "diff";
  allowedPaths?: string[];
  requiredPaths?: string[];
  forbiddenPaths?: string[];
  maxChangedFiles?: number;
  contains?: string[];
  notContains?: string[];
  preserveExisting?: boolean;
}

export interface StateGrader extends GraderBase {
  type: "state";
  finishReason?: string;
  minCheckpoints?: number;
  maxToolFailures?: number;
  maxTurns?: number;
  maxApprovals?: number;
  maxSecurityFindings?: number;
}

export interface ResponseGrader extends GraderBase {
  type: "response";
  equals?: string;
  contains?: string[];
  notContains?: string[];
}

export type EvaluationGrader =
  | OutcomeGrader
  | TrajectoryGrader
  | CommandGrader
  | FileGrader
  | DiffGrader
  | StateGrader
  | ResponseGrader;

export interface EvaluationGraderResult {
  id: string;
  type: EvaluationGrader["type"];
  passed: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface EvaluationBaseline {
  gitError?: string;
  dirtyFiles: Map<string, { status: string; fingerprint: string }>;
  watchedFiles: Map<string, string>;
}

export function validateEvaluationGraders(value: unknown, scenarioId: string): EvaluationGrader[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`评测场景 ${scenarioId} 的 graders 必须包含 1 到 20 项`);
  }
  const ids = new Set<string>();
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      throw new Error(`评测场景 ${scenarioId} 的 grader ${index + 1} 缺少 type`);
    }
    if (raw.id !== undefined && (typeof raw.id !== "string" || raw.id.trim().length === 0)) {
      throw new Error(`评测场景 ${scenarioId} 的 grader ${index + 1} id 非法`);
    }
    const id = typeof raw.id === "string" ? raw.id : `${raw.type}-${index + 1}`;
    if (ids.has(id)) throw new Error(`评测场景 ${scenarioId} 的 grader id 重复：${id}`);
    ids.add(id);
    validateGrader(raw, scenarioId, index);
  }
  return value as EvaluationGrader[];
}

export async function captureEvaluationBaseline(
  cwd: string,
  graders: EvaluationGrader[],
): Promise<EvaluationBaseline> {
  const baseline: EvaluationBaseline = { dirtyFiles: new Map(), watchedFiles: new Map() };
  if (graders.some((grader) => grader.type === "diff")) {
    try {
      const entries = await new GitAdapter({ cwd }).statusEntries();
      for (const entry of entries) {
        const relative = normalizeGitPath(entry.path);
        baseline.dirtyFiles.set(relative, {
          status: `${entry.index}${entry.worktree}`,
          fingerprint: await fingerprintWorkspacePath(cwd, relative),
        });
      }
    } catch (error) {
      baseline.gitError = error instanceof Error ? error.message : String(error);
    }
  }
  for (const grader of graders) {
    if (grader.type !== "file" || !grader.unchanged) continue;
    baseline.watchedFiles.set(grader.path, await fingerprintWorkspacePath(cwd, grader.path));
  }
  return baseline;
}

export async function evaluateGraders(
  graders: EvaluationGrader[],
  result: RunResult,
  cwd: string,
  baseline: EvaluationBaseline,
): Promise<EvaluationGraderResult[]> {
  const results: EvaluationGraderResult[] = [];
  for (const [index, grader] of graders.entries()) {
    const id = grader.id ?? `${grader.type}-${index + 1}`;
    try {
      const verdict = await evaluateGrader(grader, result, cwd, baseline);
      results.push({ id, type: grader.type, ...verdict });
    } catch (error) {
      results.push({
        id,
        type: grader.type,
        passed: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function evaluateGrader(
  grader: EvaluationGrader,
  result: RunResult,
  cwd: string,
  baseline: EvaluationBaseline,
): Promise<Omit<EvaluationGraderResult, "id" | "type">> {
  switch (grader.type) {
    case "outcome":
      if (result.outcome.status !== grader.status) {
        return {
          passed: false,
          reason: `期望状态 ${grader.status}，实际 ${result.outcome.status}`,
        };
      }
      if (
        grader.finishReason !== undefined &&
        result.outcome.finishReason !== grader.finishReason
      ) {
        return {
          passed: false,
          reason: `期望 finishReason ${grader.finishReason}，实际 ${result.outcome.finishReason}`,
        };
      }
      return { passed: true };
    case "trajectory":
      return evaluateTrajectory(grader, result);
    case "command":
      return evaluateCommand(grader, cwd);
    case "file":
      return evaluateFile(grader, cwd, baseline);
    case "diff":
      return evaluateDiff(grader, cwd, baseline);
    case "state":
      return evaluateState(grader, result);
    case "response":
      return evaluateText(result.transcript, grader);
  }
}

function evaluateTrajectory(
  grader: TrajectoryGrader,
  result: RunResult,
): Omit<EvaluationGraderResult, "id" | "type"> {
  const calls = result.trace
    .map((entry) => entry.event)
    .filter(
      (event): event is Extract<typeof event, { type: "tool_call" }> => event.type === "tool_call",
    );
  const callResults = new Map(
    result.trace
      .map((entry) => entry.event)
      .filter(
        (event): event is Extract<typeof event, { type: "tool_result" }> =>
          event.type === "tool_result" && event.callId !== undefined,
      )
      .map((event) => [event.callId!, event.isError]),
  );
  let cursor = 0;
  for (const expected of grader.sequence) {
    const found = calls.findIndex((call, index) => {
      if (index < cursor || call.tool !== expected.tool) return false;
      if (
        expected.argsContains !== undefined &&
        !JSON.stringify(call.args).includes(expected.argsContains)
      ) {
        return false;
      }
      if (expected.result === undefined) return true;
      if (!call.callId || !callResults.has(call.callId)) return false;
      return callResults.get(call.callId) === (expected.result === "failed");
    });
    if (found < 0) {
      return {
        passed: false,
        reason: `工具轨迹缺少有序步骤 ${expected.tool}${expected.argsContains ? `(${expected.argsContains})` : ""}${expected.result ? `[${expected.result}]` : ""}`,
      };
    }
    cursor = found + 1;
  }
  const forbidden = calls.find((call) => grader.forbiddenTools?.includes(call.tool));
  if (forbidden) return { passed: false, reason: `工具轨迹包含禁止工具 ${forbidden.tool}` };
  if (
    grader.maxToolFailures !== undefined &&
    result.metrics.toolFailures > grader.maxToolFailures
  ) {
    return {
      passed: false,
      reason: `工具失败 ${result.metrics.toolFailures} 次，超过 ${grader.maxToolFailures} 次上限`,
    };
  }
  return { passed: true, evidence: { toolCalls: calls.map((call) => call.tool) } };
}

async function evaluateCommand(
  grader: CommandGrader,
  cwd: string,
): Promise<Omit<EvaluationGraderResult, "id" | "type">> {
  const commandCwd =
    grader.cwd === undefined ? path.resolve(cwd) : await safeWorkspacePath(cwd, grader.cwd);
  const result = await new ProcessRunner().run({
    command: grader.command,
    args: grader.args,
    cwd: commandCwd,
    timeoutMs: grader.timeoutMs ?? 30_000,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const expectedExit = grader.exitCode ?? 0;
  if (result.exitCode !== expectedExit) {
    return {
      passed: false,
      reason: `命令退出码期望 ${expectedExit}，实际 ${result.exitCode ?? "unknown"}`,
      evidence: { exitCode: result.exitCode, durationMs: result.durationMs },
    };
  }
  const stdout = evaluateStringRules(
    result.stdout,
    grader.stdoutContains,
    grader.stdoutNotContains,
    "stdout",
  );
  if (stdout) return { passed: false, reason: stdout };
  const stderr = evaluateStringRules(
    result.stderr,
    grader.stderrContains,
    grader.stderrNotContains,
    "stderr",
  );
  if (stderr) return { passed: false, reason: stderr };
  return { passed: true, evidence: { exitCode: result.exitCode, durationMs: result.durationMs } };
}

async function evaluateFile(
  grader: FileGrader,
  cwd: string,
  baseline: EvaluationBaseline,
): Promise<Omit<EvaluationGraderResult, "id" | "type">> {
  const expectedExists = grader.exists ?? true;
  const target = await safeWorkspacePath(cwd, grader.path);
  let stats: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    stats = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((stats !== undefined) !== expectedExists) {
    return { passed: false, reason: `文件 ${grader.path} 的存在状态不符合预期` };
  }
  if (!stats) return { passed: true };
  if (!stats.isFile()) return { passed: false, reason: `${grader.path} 不是普通文件` };
  const maxBytes = grader.maxBytes ?? 2 * 1024 * 1024;
  if (stats.size > maxBytes)
    return { passed: false, reason: `${grader.path} 超过 ${maxBytes} 字节上限` };
  const content = await readFile(target, "utf8");
  const textVerdict = evaluateText(content, grader);
  if (!textVerdict.passed) return textVerdict;
  if (grader.unchanged) {
    const before = baseline.watchedFiles.get(grader.path);
    const after = await fingerprintWorkspacePath(cwd, grader.path);
    if (before === undefined || before !== after) {
      return { passed: false, reason: `受保护文件 ${grader.path} 已发生变化` };
    }
  }
  return { passed: true, evidence: { bytes: stats.size } };
}

async function evaluateDiff(
  grader: DiffGrader,
  cwd: string,
  baseline: EvaluationBaseline,
): Promise<Omit<EvaluationGraderResult, "id" | "type">> {
  if (baseline.gitError)
    return { passed: false, reason: `无法建立 Git 基线：${baseline.gitError}` };
  const adapter = new GitAdapter({ cwd });
  const afterEntries = await adapter.statusEntries();
  const after = new Map(
    afterEntries.map((entry) => [normalizeGitPath(entry.path), `${entry.index}${entry.worktree}`]),
  );
  if (grader.preserveExisting !== false) {
    for (const [file, before] of baseline.dirtyFiles) {
      const fingerprint = await fingerprintWorkspacePath(cwd, file);
      if (fingerprint !== before.fingerprint) {
        return { passed: false, reason: `既有脏工作区内容被修改：${file}` };
      }
    }
  }
  const changedPaths = [...after]
    .filter(([file, status]) => baseline.dirtyFiles.get(file)?.status !== status)
    .map(([file]) => file)
    .sort();
  const disallowed = changedPaths.find(
    (file) =>
      grader.allowedPaths && !grader.allowedPaths.some((allowed) => matchesPath(file, allowed)),
  );
  if (disallowed) return { passed: false, reason: `diff 包含未允许文件：${disallowed}` };
  const forbidden = changedPaths.find((file) =>
    grader.forbiddenPaths?.some((blocked) => matchesPath(file, blocked)),
  );
  if (forbidden) return { passed: false, reason: `diff 修改了禁止文件：${forbidden}` };
  const missing = grader.requiredPaths?.find(
    (required) => !changedPaths.some((file) => matchesPath(file, required)),
  );
  if (missing) return { passed: false, reason: `diff 缺少必须修改的文件：${missing}` };
  if (grader.maxChangedFiles !== undefined && changedPaths.length > grader.maxChangedFiles) {
    return {
      passed: false,
      reason: `Agent 新增变更 ${changedPaths.length} 个文件，超过 ${grader.maxChangedFiles} 个上限`,
    };
  }
  const patch = `${await adapter.diff()}\n${await adapter.diff({ staged: true })}`;
  const textFailure = evaluateStringRules(patch, grader.contains, grader.notContains, "diff");
  if (textFailure) return { passed: false, reason: textFailure };
  return { passed: true, evidence: { changedPaths } };
}

function evaluateState(
  grader: StateGrader,
  result: RunResult,
): Omit<EvaluationGraderResult, "id" | "type"> {
  const approvals = result.trace.filter((entry) => entry.event.type === "approval_required").length;
  const checks: Array<[boolean, string]> = [
    [
      grader.finishReason === undefined || result.outcome.finishReason === grader.finishReason,
      `finishReason 期望 ${grader.finishReason}，实际 ${result.outcome.finishReason}`,
    ],
    [
      grader.minCheckpoints === undefined || result.checkpoints.length >= grader.minCheckpoints,
      `checkpoint 数量 ${result.checkpoints.length} 少于 ${grader.minCheckpoints}`,
    ],
    [
      grader.maxToolFailures === undefined || result.metrics.toolFailures <= grader.maxToolFailures,
      `工具失败 ${result.metrics.toolFailures} 次，超过 ${grader.maxToolFailures}`,
    ],
    [
      grader.maxTurns === undefined || result.metrics.turns <= grader.maxTurns,
      `turn 数量 ${result.metrics.turns} 超过 ${grader.maxTurns}`,
    ],
    [
      grader.maxApprovals === undefined || approvals <= grader.maxApprovals,
      `审批次数 ${approvals} 超过 ${grader.maxApprovals}`,
    ],
    [
      grader.maxSecurityFindings === undefined ||
        result.evaluation.securityFindings.length <= grader.maxSecurityFindings,
      `安全发现 ${result.evaluation.securityFindings.length} 项，超过 ${grader.maxSecurityFindings}`,
    ],
  ];
  const failure = checks.find(([passed]) => !passed);
  return failure
    ? { passed: false, reason: failure[1] }
    : { passed: true, evidence: { checkpoints: result.checkpoints.length, approvals } };
}

function evaluateText(
  text: string,
  rules: Pick<ResponseGrader | FileGrader, "equals" | "contains" | "notContains">,
): Omit<EvaluationGraderResult, "id" | "type"> {
  if (rules.equals !== undefined && text !== rules.equals) {
    return { passed: false, reason: "文本与 equals 不一致" };
  }
  const failure = evaluateStringRules(text, rules.contains, rules.notContains, "文本");
  return failure ? { passed: false, reason: failure } : { passed: true };
}

function evaluateStringRules(
  text: string,
  contains: string[] | undefined,
  notContains: string[] | undefined,
  label: string,
): string | undefined {
  for (const expected of contains ?? []) {
    if (!text.includes(expected)) return `${label} 缺少：${expected}`;
  }
  for (const blocked of notContains ?? []) {
    if (text.includes(blocked)) return `${label} 不应包含：${blocked}`;
  }
  return undefined;
}

function validateGrader(raw: Record<string, unknown>, scenarioId: string, index: number): void {
  const prefix = `评测场景 ${scenarioId} 的 grader ${index + 1}`;
  switch (raw.type) {
    case "outcome":
      if (!RUN_STATUSES.includes(raw.status as RunStatus)) throw new Error(`${prefix} status 非法`);
      optionalString(raw.finishReason, `${prefix} finishReason`);
      return;
    case "trajectory":
      if (!Array.isArray(raw.sequence) || raw.sequence.length === 0) {
        throw new Error(`${prefix} sequence 不能为空`);
      }
      for (const step of raw.sequence) {
        if (!isRecord(step) || !nonEmptyString(step.tool))
          throw new Error(`${prefix} sequence 非法`);
        optionalString(step.argsContains, `${prefix} argsContains`);
        if (step.result !== undefined && step.result !== "succeeded" && step.result !== "failed") {
          throw new Error(`${prefix} sequence.result 非法`);
        }
      }
      optionalStringArray(raw.forbiddenTools, `${prefix} forbiddenTools`);
      optionalInteger(raw.maxToolFailures, 0, 10_000, `${prefix} maxToolFailures`);
      return;
    case "command":
      if (!nonEmptyString(raw.command)) throw new Error(`${prefix} command 不能为空`);
      optionalStringArray(raw.args, `${prefix} args`);
      optionalString(raw.cwd, `${prefix} cwd`);
      optionalInteger(raw.exitCode, -255, 255, `${prefix} exitCode`);
      validateTextArrays(raw, prefix, [
        "stdoutContains",
        "stdoutNotContains",
        "stderrContains",
        "stderrNotContains",
      ]);
      optionalInteger(raw.timeoutMs, 1, 600_000, `${prefix} timeoutMs`);
      return;
    case "file":
      if (!nonEmptyString(raw.path)) throw new Error(`${prefix} path 不能为空`);
      optionalBoolean(raw.exists, `${prefix} exists`);
      optionalBoolean(raw.unchanged, `${prefix} unchanged`);
      optionalString(raw.equals, `${prefix} equals`);
      validateTextArrays(raw, prefix, ["contains", "notContains"]);
      optionalInteger(raw.maxBytes, 1, 100 * 1024 * 1024, `${prefix} maxBytes`);
      return;
    case "diff":
      validateTextArrays(raw, prefix, [
        "allowedPaths",
        "requiredPaths",
        "forbiddenPaths",
        "contains",
        "notContains",
      ]);
      optionalInteger(raw.maxChangedFiles, 0, 10_000, `${prefix} maxChangedFiles`);
      optionalBoolean(raw.preserveExisting, `${prefix} preserveExisting`);
      return;
    case "state":
      optionalString(raw.finishReason, `${prefix} finishReason`);
      for (const field of [
        "minCheckpoints",
        "maxToolFailures",
        "maxTurns",
        "maxApprovals",
        "maxSecurityFindings",
      ]) {
        optionalInteger(raw[field], 0, 1_000_000, `${prefix} ${field}`);
      }
      return;
    case "response":
      optionalString(raw.equals, `${prefix} equals`);
      validateTextArrays(raw, prefix, ["contains", "notContains"]);
      if (raw.equals === undefined && raw.contains === undefined && raw.notContains === undefined) {
        throw new Error(`${prefix} 至少需要一项文本规则`);
      }
      return;
    default:
      throw new Error(`${prefix} type 非法：${String(raw.type)}`);
  }
}

const RUN_STATUSES: RunStatus[] = [
  "succeeded",
  "failed",
  "paused",
  "aborted",
  "timeout",
  "budget_exceeded",
];

function validateTextArrays(raw: Record<string, unknown>, prefix: string, fields: string[]): void {
  for (const field of fields) optionalStringArray(raw[field], `${prefix} ${field}`);
}

function optionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label} 必须是字符串`);
}

function optionalStringArray(value: unknown, label: string): void {
  if (value !== undefined && !isStringArray(value)) throw new Error(`${label} 必须是字符串数组`);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${label} 必须是布尔值`);
}

function optionalInteger(value: unknown, min: number, max: number, label: string): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
  ) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 的整数`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function matchesPath(candidate: string, expected: string): boolean {
  const normalizedCandidate = normalizeGitPath(candidate);
  const normalizedExpected = normalizeGitPath(expected);
  if (normalizedExpected.endsWith("/**")) {
    return normalizedCandidate.startsWith(normalizedExpected.slice(0, -2));
  }
  return normalizedCandidate === normalizedExpected;
}

async function fingerprintWorkspacePath(cwd: string, input: string): Promise<string> {
  const target = await safeWorkspacePath(cwd, input, false);
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return `symlink:${await readlink(target)}`;
    if (!stats.isFile()) return `other:${stats.mode}:${stats.size}`;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(target)) hash.update(chunk as Buffer);
    return `file:${hash.digest("hex")}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function safeWorkspacePath(cwd: string, input: string, follow = true): Promise<string> {
  if (input.length === 0 || input.includes("\0")) throw new Error(`工作区路径非法：${input}`);
  const lexicalRoot = path.resolve(cwd);
  const lexicalTarget = path.resolve(lexicalRoot, input);
  if (isOutside(lexicalRoot, lexicalTarget)) throw new Error(`路径超出评测工作区：${input}`);
  if (!follow) return lexicalTarget;
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalize(lexicalRoot),
    canonicalize(lexicalTarget),
  ]);
  if (isOutside(canonicalRoot, canonicalTarget)) throw new Error(`路径超出评测工作区：${input}`);
  return canonicalTarget;
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function canonicalize(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return current;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(input);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
