import { readFile } from "node:fs/promises";
import type { CoreMindConfig } from "coremind-config";
import { parseConfigText } from "coremind-config";
import {
  captureEvaluationBaseline,
  type EvaluationGrader,
  type EvaluationGraderResult,
  evaluateGraders,
  validateEvaluationGraders,
} from "./evaluation-graders.js";
import type { EvaluationReport, ReleaseReadiness, RunOutcome } from "./result.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions, type RunResult } from "./runtime.js";
import type { ApprovalDecision, ToolApprovalRequest } from "./tool-policy.js";

export type {
  CommandGrader,
  DiffGrader,
  EvaluationGrader,
  EvaluationGraderResult,
  FileGrader,
  OutcomeGrader,
  ResponseGrader,
  StateGrader,
  TrajectoryGrader,
  TrajectoryStep,
} from "./evaluation-graders.js";

export interface EvaluationExpectation {
  outcome?: "succeeded" | "failed";
  equals?: string;
  contains?: string[];
  notContains?: string[];
}

export interface EvaluationScenario {
  id: string;
  input: string;
  expected?: EvaluationExpectation;
  graders?: EvaluationGrader[];
  repetitions?: number;
}

export interface EvaluationSuite {
  schemaVersion: 1 | 2;
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
  graderResults: EvaluationGraderResult[];
  metrics?: RunResult["metrics"];
  approvalCount: number;
  toolTrajectory: Array<{ tool: string; callId?: string; isError?: boolean }>;
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
  if (
    (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) ||
    !Array.isArray(candidate.scenarios)
  ) {
    throw new Error("评测文件需要 schemaVersion: 1 或 2 和 scenarios 数组");
  }
  const ids = new Set<string>();
  for (const scenario of candidate.scenarios) {
    if (
      scenario === null ||
      typeof scenario !== "object" ||
      typeof scenario.id !== "string" ||
      scenario.id.trim().length === 0 ||
      typeof scenario.input !== "string"
    ) {
      throw new Error("每个评测场景必须包含 id 和 input");
    }
    if (ids.has(scenario.id)) throw new Error(`评测场景 id 重复：${scenario.id}`);
    ids.add(scenario.id);

    if (candidate.schemaVersion === 1) {
      if (scenario.expected === null || typeof scenario.expected !== "object") {
        throw new Error(`评测场景 ${scenario.id} 在 schemaVersion 1 下必须包含 expected`);
      }
      validateLegacyExpectation(scenario.expected, scenario.id);
      if (scenario.graders !== undefined) {
        throw new Error(`评测场景 ${scenario.id} 使用 graders 时必须升级到 schemaVersion: 2`);
      }
    } else {
      const graders = validateEvaluationGraders(scenario.graders, scenario.id);
      if (!graders.some((grader) => grader.type === "outcome")) {
        throw new Error(`评测场景 ${scenario.id} 必须包含 outcome grader`);
      }
      if (scenario.expected !== undefined) {
        throw new Error(`评测场景 ${scenario.id} 在 schemaVersion 2 下请使用 response grader`);
      }
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
      const graders = scenario.graders ?? legacyGraders(scenario.expected ?? {});
      const cwd = options.cwd ?? options.configDir;
      const baseline = await captureEvaluationBaseline(cwd, graders);
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
        const graderResults = await evaluateGraders(graders, result, cwd, baseline);
        const verdict = graderVerdict(graderResults);
        attempts.push({
          scenarioId: scenario.id,
          attempt,
          passed: verdict.passed,
          transcript: result.transcript,
          outcome: result.outcome,
          reason: verdict.reason,
          runId: result.runId,
          graderResults,
          metrics: result.metrics,
          approvalCount: countApprovals(result),
          toolTrajectory: summarizeToolTrajectory(result),
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
        const failedResult = failedRunResult(outcome);
        const graderResults = await evaluateGraders(graders, failedResult, cwd, baseline);
        const verdict = graderVerdict(graderResults);
        attempts.push({
          scenarioId: scenario.id,
          attempt,
          passed: verdict.passed,
          transcript: "",
          outcome,
          reason: verdict.reason,
          graderResults,
          metrics: failedResult.metrics,
          approvalCount: 0,
          toolTrajectory: [],
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

function validateLegacyExpectation(value: unknown, scenarioId: string): void {
  const expected = value as Partial<EvaluationExpectation>;
  if (
    expected.outcome !== undefined &&
    expected.outcome !== "succeeded" &&
    expected.outcome !== "failed"
  ) {
    throw new Error(`评测场景 ${scenarioId} 的 expected.outcome 非法`);
  }
  if (expected.equals !== undefined && typeof expected.equals !== "string") {
    throw new Error(`评测场景 ${scenarioId} 的 expected.equals 必须是字符串`);
  }
  if (expected.contains !== undefined && !isStringArray(expected.contains)) {
    throw new Error(`评测场景 ${scenarioId} 的 expected.contains 必须是字符串数组`);
  }
  if (expected.notContains !== undefined && !isStringArray(expected.notContains)) {
    throw new Error(`评测场景 ${scenarioId} 的 expected.notContains 必须是字符串数组`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function legacyGraders(expected: EvaluationExpectation): EvaluationGrader[] {
  const graders: EvaluationGrader[] = [
    { type: "outcome", status: expected.outcome ?? "succeeded" },
  ];
  if (
    expected.equals !== undefined ||
    expected.contains !== undefined ||
    expected.notContains !== undefined
  ) {
    graders.push({
      type: "response",
      equals: expected.equals,
      contains: expected.contains,
      notContains: expected.notContains,
    });
  }
  return graders;
}

function graderVerdict(results: EvaluationGraderResult[]): { passed: boolean; reason?: string } {
  const failed = results.find((result) => !result.passed);
  return failed
    ? { passed: false, reason: `${failed.id}: ${failed.reason ?? "未通过"}` }
    : { passed: true };
}

function countApprovals(result: RunResult): number {
  return result.trace.filter((entry) => entry.event.type === "approval_required").length;
}

function summarizeToolTrajectory(
  result: RunResult,
): Array<{ tool: string; callId?: string; isError?: boolean }> {
  const results = new Map(
    result.trace
      .map((entry) => entry.event)
      .filter(
        (event): event is Extract<typeof event, { type: "tool_result" }> =>
          event.type === "tool_result" && event.callId !== undefined,
      )
      .map((event) => [event.callId!, event.isError]),
  );
  return result.trace
    .map((entry) => entry.event)
    .filter(
      (event): event is Extract<typeof event, { type: "tool_call" }> => event.type === "tool_call",
    )
    .map((event) => ({
      tool: event.tool,
      ...(event.callId ? { callId: event.callId, isError: results.get(event.callId) } : {}),
    }));
}

function failedRunResult(outcome: RunOutcome): RunResult {
  return {
    runId: "evaluation-error",
    outcome,
    metrics: {
      durationMs: 0,
      turns: 0,
      steps: { total: 0, succeeded: 0, failed: 0 },
      toolCalls: 0,
      toolFailures: 0,
      retries: 0,
      outputChars: 0,
    },
    evaluation: {
      profile: "standard",
      scenarioResults: [],
      qualityScores: {},
      securityFindings: [],
    },
    releaseReadiness: { ready: false, blockers: ["运行异常"], warnings: [] },
    trace: [],
    checkpoints: [],
    outputs: new Map(),
    messages: new Map(),
    transcript: "",
  };
}
