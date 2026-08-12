import { createHash } from "node:crypto";
import type { CoreMindEvent, ToolExecutionEvidence } from "../events.js";

export interface RuntimeEngineeringEvidencePolicy {
  regressionCommand: string;
  minSuccessfulTestCommands?: number;
  requireCheckpoint?: boolean;
  requireDiffReview?: boolean;
}

export interface RuntimeEngineeringEvidenceReport {
  passed: boolean;
  successfulTestCommands: number;
  regressionCommandMatched: boolean;
  checkpointRecorded: boolean;
  diffReviewed: boolean;
  reasons: string[];
}

/** 从真实工具执行上下文提取不含命令原文的审计元数据。 */
export function createToolExecutionEvidence(input: {
  tool: string;
  args: unknown;
  isError: boolean;
  result: unknown;
  durationMs: number;
}): ToolExecutionEvidence {
  const command = input.tool === "bash" ? commandArgument(input.args) : undefined;
  return {
    durationMs: Math.max(0, input.durationMs),
    exitCode: input.isError ? extractExitCode(input.result) : 0,
    ...(command
      ? {
          commandSha256: commandFingerprint(command),
          testCommand: looksLikeTestCommand(command),
        }
      : {}),
  };
}

/** 只依据 Runtime Trace 中真实发生的工具、Checkpoint 与 Diff 记录判定。 */
export function assessRuntimeEngineeringEvidence(
  events: readonly CoreMindEvent[],
  policy: RuntimeEngineeringEvidencePolicy,
  verificationStepId: string,
): RuntimeEngineeringEvidenceReport {
  const successfulTests = new Set<string>();
  let regressionCommandMatched = false;
  let diffReviewed = false;
  let checkpointRecorded = false;
  const regressionFingerprint = commandFingerprint(policy.regressionCommand);

  for (const event of events) {
    if (
      event.type === "checkpoint_created" &&
      event.reversible &&
      (event.tool === "edit" || event.tool === "write")
    ) {
      checkpointRecorded = true;
    }
    if (
      event.type === "tool_result" &&
      event.stepId === verificationStepId &&
      event.tool === "git_diff" &&
      !event.isError
    ) {
      diffReviewed = true;
    }
    if (
      event.type !== "tool_execution_evidence" ||
      event.stepId !== verificationStepId ||
      event.tool !== "bash" ||
      event.execution?.exitCode !== 0 ||
      !event.execution.testCommand ||
      !event.execution.commandSha256
    ) {
      continue;
    }
    successfulTests.add(event.execution.commandSha256);
    if (event.execution.commandSha256 === regressionFingerprint) {
      regressionCommandMatched = true;
    }
  }

  const minimum = policy.minSuccessfulTestCommands ?? 2;
  const reasons: string[] = [];
  if (successfulTests.size < minimum) {
    reasons.push(`成功测试命令不足：需要 ${minimum} 条，实际 ${successfulTests.size} 条`);
  }
  if (!regressionCommandMatched) reasons.push("未执行配置的完整回归命令或命令未成功");
  if ((policy.requireCheckpoint ?? true) && !checkpointRecorded) {
    reasons.push("没有可恢复的写前 Checkpoint");
  }
  if ((policy.requireDiffReview ?? true) && !diffReviewed) {
    reasons.push("验证阶段没有成功执行 git_diff");
  }

  return {
    passed: reasons.length === 0,
    successfulTestCommands: successfulTests.size,
    regressionCommandMatched,
    checkpointRecorded,
    diffReviewed,
    reasons,
  };
}

export function commandFingerprint(command: string): string {
  return createHash("sha256").update(command.replaceAll("\r\n", "\n").trim()).digest("hex");
}

function commandArgument(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function looksLikeTestCommand(command: string): boolean {
  return /(?:^|[;&|\s])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)|\b(?:vitest|jest|mocha|pytest)\b|python\s+-m\s+(?:pytest|unittest)\b|\b(?:cargo|go|dotnet)\s+test\b|\b(?:mvn|gradle|gradlew)\b[^\r\n]*(?:test|check)/iu.test(
    command,
  );
}

function extractExitCode(result: unknown): number | null {
  const text = JSON.stringify(result);
  const matched = /Command exited with code\s+(-?\d+)/iu.exec(text);
  return matched ? Number(matched[1]) : null;
}
