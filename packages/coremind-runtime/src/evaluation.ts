import { readFile } from "node:fs/promises";
import type { CoreMindConfig } from "coremind-config";
import { parseConfigText } from "coremind-config";
import type { EvaluationReport, ReleaseReadiness, RunOutcome } from "./result.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions, type RunResult } from "./runtime.js";
import type { ApprovalDecision, ToolApprovalRequest } from "./tool-policy.js";

export interface EvaluationExpectation {
  outcome?: "succeeded" | "failed";
  equals?: string;
  contains?: string[];
  notContains?: string[];
}

export interface EvaluationScenario {
  id: string;
  input: string;
  expected: EvaluationExpectation;
  repetitions?: number;
}

export interface EvaluationSuite {
  schemaVersion: 1;
  scenarios: EvaluationScenario[];
}

export interface EvaluationAttempt {
  scenarioId: string;
  attempt: number;
  passed: boolean;
  transcript: string;
  outcome: RunOutcome;
  reason?: string;
  runId?: string;
}

export interface EvaluationSuiteResult {
  report: EvaluationReport;
  releaseReadiness: ReleaseReadiness;
  attempts: EvaluationAttempt[];
  passRate: number;
  totalRuns: number;
}

export type EvaluationRuntime = { run(): Promise<RunResult> };
export type EvaluationRuntimeFactory = (
  options: CoreMindRuntimeOptions,
) => Promise<EvaluationRuntime>;

export interface RunEvaluationOptions {
  config: CoreMindConfig;
  configDir: string;
  cwd?: string;
  suite: EvaluationSuite;
  runtimeFactory?: EvaluationRuntimeFactory;
  approveTool?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
}

export async function loadEvaluationSuite(file: string): Promise<EvaluationSuite> {
  const text = await readFile(file, "utf8");
  return validateEvaluationSuite(parseConfigText(text, file));
}

export function validateEvaluationSuite(value: unknown): EvaluationSuite {
  if (value === null || typeof value !== "object") throw new Error("评测文件必须是对象");
  const candidate = value as Partial<EvaluationSuite>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.scenarios)) {
    throw new Error("评测文件需要 schemaVersion: 1 和 scenarios 数组");
  }
  const ids = new Set<string>();
  for (const scenario of candidate.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== "object" ||
      typeof scenario.id !== "string" ||
      scenario.id.trim().length === 0 ||
      typeof scenario.input !== "string" ||
      scenario.expected === null ||
      typeof scenario.expected !== "object"
    ) {
      throw new Error("每个评测场景必须包含 id、input 和 expected");
    }
    if (ids.has(scenario.id)) throw new Error(`评测场景 id 重复：${scenario.id}`);
    ids.add(scenario.id);

    const expected = scenario.expected as Partial<EvaluationExpectation>;
    if (
      expected.outcome !== undefined &&
      expected.outcome !== "succeeded" &&
      expected.outcome !== "failed"
    ) {
      throw new Error(`评测场景 ${scenario.id} 的 expected.outcome 非法`);
    }
    if (expected.equals !== undefined && typeof expected.equals !== "string") {
      throw new Error(`评测场景 ${scenario.id} 的 expected.equals 必须是字符串`);
    }
    if (expected.contains !== undefined && !isStringArray(expected.contains)) {
      throw new Error(`评测场景 ${scenario.id} 的 expected.contains 必须是字符串数组`);
    }
    if (expected.notContains !== undefined && !isStringArray(expected.notContains)) {
      throw new Error(`评测场景 ${scenario.id} 的 expected.notContains 必须是字符串数组`);
    }
    if (
      scenario.repetitions !== undefined &&
      (!Number.isInteger(scenario.repetitions) ||
        scenario.repetitions < 1 ||
        scenario.repetitions > 100)
    ) {
      throw new Error(`评测场景 ${scenario.id} 的 repetitions 必须是 1 到 100 的整数`);
    }
  }
  if (candidate.scenarios.length === 0) throw new Error("评测场景不能为空");
  return candidate as EvaluationSuite;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 使用真实 CoreMindRuntime 重复运行场景，失败异常也会进入评测报告。 */
export async function runEvaluationSuite(
  options: RunEvaluationOptions,
): Promise<EvaluationSuiteResult> {
  const suite = validateEvaluationSuite(options.suite);
  const profile = options.config.quality?.profile ?? "standard";
  const factory = options.runtimeFactory ?? CoreMindRuntime.create;
  const attempts: EvaluationAttempt[] = [];
  const securityFindings = new Set<string>();

  for (const scenario of suite.scenarios) {
    const repetitions = Math.max(scenario.repetitions ?? 1, profile === "strict" ? 3 : 1);
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      try {
        const runtime = await factory({
          config: options.config,
          configDir: options.configDir,
          cwd: options.cwd,
          initialPrompt: scenario.input,
          approveTool: options.approveTool,
        });
        const result = await runtime.run();
        for (const finding of result.evaluation.securityFindings) securityFindings.add(finding);
        const verdict = evaluateExpectation(result.outcome, result.transcript, scenario.expected);
        attempts.push({
          scenarioId: scenario.id,
          attempt,
          passed: verdict.passed,
          transcript: result.transcript,
          outcome: result.outcome,
          reason: verdict.reason,
          runId: result.runId,
        });
      } catch (error) {
        const code =
          error !== null && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "unknown";
        const outcome: RunOutcome = {
          status: "failed",
          finishReason: code,
          error: { code, message: error instanceof Error ? error.message : String(error) },
        };
        const verdict = evaluateExpectation(outcome, "", scenario.expected);
        attempts.push({
          scenarioId: scenario.id,
          attempt,
          passed: verdict.passed,
          transcript: "",
          outcome,
          reason: verdict.reason,
        });
      }
    }
  }

  const scenarioResults = suite.scenarios.map((scenario) => {
    const own = attempts.filter((attempt) => attempt.scenarioId === scenario.id);
    const score = own.filter((attempt) => attempt.passed).length / own.length;
    return {
      id: scenario.id,
      passed: score === 1,
      score,
      ...(score === 1
        ? {}
        : { reason: own.find((attempt) => !attempt.passed)?.reason ?? "存在失败运行" }),
    };
  });
  const passedRuns = attempts.filter((attempt) => attempt.passed).length;
  const passRate = attempts.length === 0 ? 0 : passedRuns / attempts.length;
  const report: EvaluationReport = {
    profile,
    scenarioResults,
    qualityScores: { passRate, stability: scenarioResults.every((item) => item.passed) ? 1 : 0 },
    securityFindings: [...securityFindings],
  };
  const threshold = options.config.quality?.minScenarioPassRate ?? 1;
  const blockers: string[] = [];
  if (passRate < threshold) blockers.push(`场景通过率 ${passRate} 低于门槛 ${threshold}`);
  if (securityFindings.size > 0) blockers.push("存在未解决的安全发现");
  const releaseReadiness: ReleaseReadiness = {
    ready: blockers.length === 0,
    blockers,
    warnings: [],
  };
  return { report, releaseReadiness, attempts, passRate, totalRuns: attempts.length };
}

function evaluateExpectation(
  outcome: RunOutcome,
  transcript: string,
  expected: EvaluationExpectation,
): { passed: boolean; reason?: string } {
  const expectedOutcome = expected.outcome ?? "succeeded";
  if (outcome.status !== expectedOutcome) {
    return { passed: false, reason: `期望 ${expectedOutcome}，实际 ${outcome.status}` };
  }
  if (expected.equals !== undefined && transcript !== expected.equals) {
    return { passed: false, reason: "输出与 expected.equals 不一致" };
  }
  for (const text of expected.contains ?? []) {
    if (!transcript.includes(text)) return { passed: false, reason: `输出缺少：${text}` };
  }
  for (const text of expected.notContains ?? []) {
    if (transcript.includes(text)) return { passed: false, reason: `输出不应包含：${text}` };
  }
  return { passed: true };
}
