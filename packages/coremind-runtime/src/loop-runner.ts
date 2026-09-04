import { createHash } from "node:crypto";
import type { LoopConfig } from "coremind-config";
import { CoreMindError, cancelSignalForCode, isErrorCode } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { normalizeExecutionError } from "./execution-error.js";
import { legacyStepId } from "./ids.js";
import {
  LoopController,
  type LoopControllerEvent,
  type LoopControllerSnapshot,
} from "./loop-controller.js";
import { type CompletedWorkflowStep, evalCondition, type StepOutput } from "./orchestrator.js";
import { classifyRetry } from "./retry-policy.js";

export type LoopStepKind = "planning" | "execute" | "verify" | "repair";

export interface LoopStepRequest {
  kind: LoopStepKind;
  stepId: string;
  agent: string;
  input: string;
}

export interface LoopRunnerOptions {
  runId: string;
  configFingerprint: string;
  initialPrompt?: string;
  loop: LoopConfig;
  executeStep: (request: LoopStepRequest) => Promise<string>;
  emit: (event: CoreMindEvent) => void;
  persistSnapshot: (snapshot: LoopControllerSnapshot) => Promise<void>;
  restoredSnapshot?: LoopControllerSnapshot;
  completedSteps?: ReadonlyMap<string, CompletedWorkflowStep>;
  /** Runtime 证据门；返回 false 时即使文本条件为真也不能完成。 */
  verifyEvidence?: (request: {
    iteration: number;
    stepId: string;
    textPassed: boolean;
  }) => boolean | Promise<boolean>;
  /** 宿主独立验收候选；持久身份与决策重放由 Runtime 负责。 */
  verifyHost?: (request: {
    iteration: number;
    stepId: string;
    candidate: string;
  }) => Promise<{ decision: "accept" | "reject"; feedback: string }>;
}

export interface LoopRunResult {
  outputs: Map<string, StepOutput>;
  transcript: string;
  snapshot: LoopControllerSnapshot;
  error?: unknown;
}

const INTERPOLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** 执行显式、有限、可恢复的规划—执行—验证—修复循环。 */
export class LoopRunner {
  readonly outputs = new Map<string, StepOutput>();
  private readonly variables = new Map<string, string>();
  private readonly controller: LoopController;
  private readonly completedSteps: ReadonlyMap<string, CompletedWorkflowStep>;

  constructor(private readonly options: LoopRunnerOptions) {
    const loop = options.loop;
    const config = {
      runId: options.runId,
      configFingerprint: options.configFingerprint,
      hasPlanning: loop.planning !== undefined,
      maxIterations: loop.maxIterations ?? 3,
      maxRepairs: loop.maxRepairs ?? 2,
      maxRepeatedAction: loop.maxRepeatedAction ?? 2,
      onFailure: loop.onFailure ?? "repair",
      onExhausted: loop.onExhausted ?? "fail",
    } as const;
    this.controller = options.restoredSnapshot
      ? LoopController.restore(config, options.restoredSnapshot)
      : new LoopController(config);
    this.completedSteps = options.completedSteps ?? new Map();
    if (options.initialPrompt !== undefined) this.variables.set("prompt", options.initialPrompt);
    for (const completed of this.completedSteps.values()) {
      if (completed.saveAs) this.saveOutput(completed.saveAs, completed.output);
    }
    this.controller.subscribe((transition) => {
      this.options.emit({
        type: "loop_state",
        from: transition.from,
        to: transition.to,
        trigger: transition.event,
        iteration: transition.snapshot.iteration,
        repairs: transition.snapshot.repairCount,
        ...(transition.snapshot.pauseReason ? { reason: transition.snapshot.pauseReason } : {}),
      });
    });
  }

  getSnapshot(): LoopControllerSnapshot {
    return this.controller.getSnapshot();
  }

  /** 由 Runtime 的总超时或外部取消入口推进到同一确定性终态。 */
  async interrupt(error: unknown): Promise<void> {
    await this.recordExecutionError(normalizeExecutionError(error));
  }

  async run(): Promise<LoopRunResult> {
    try {
      if (this.controller.phase === "paused") await this.sendAndPersist({ type: "RESUME" });
      if (this.controller.phase === "idle") await this.sendAndPersist({ type: "START" });

      while (!isTerminal(this.controller.phase)) {
        switch (this.controller.phase) {
          case "planning":
            await this.runPlanning();
            break;
          case "executing":
            await this.runExecution();
            break;
          case "verifying":
            await this.runVerification();
            break;
          case "repairing":
            await this.runRepair();
            break;
          case "paused":
            return this.result(terminalError(this.controller.getSnapshot()));
          default:
            throw new CoreMindError(
              "loop_state_invalid",
              `Loop 进入无法执行的状态：${this.controller.phase}`,
            );
        }
      }
      return this.result(terminalError(this.controller.getSnapshot()));
    } catch (error) {
      const normalized = normalizeExecutionError(error);
      await this.recordExecutionError(normalized);
      return this.result(errorForCaller(normalized, this.controller.getSnapshot()));
    }
  }

  private async runPlanning(): Promise<void> {
    const planning = this.options.loop.planning;
    if (!planning)
      throw new CoreMindError("loop_config_invalid", "Loop 规划阶段缺少 planning 配置");
    const output = await this.runStep(
      "planning",
      "loop-plan",
      planning.agent,
      this.interpolate(planning.input),
      "plan",
    );
    this.saveOutput("plan", output);
    await this.sendAndPersist({ type: "PLANNED" });
  }

  private async runExecution(): Promise<void> {
    const action = this.options.loop.execute;
    const iteration = this.controller.getSnapshot().iteration;
    const output = await this.runStep(
      "execute",
      `loop-execute:${iteration}`,
      action.agent,
      this.interpolate(action.input),
      "candidate",
    );
    this.saveOutput("candidate", output);
    await this.sendAndPersist({ type: "EXECUTED", fingerprint: progressFingerprint(output.text) });
  }

  private async runVerification(): Promise<void> {
    const verification = this.options.loop.verify;
    const iteration = this.controller.getSnapshot().iteration;
    this.variables.set("iteration", String(iteration));
    if (verification.mode === "host") {
      if (!this.options.verifyHost) {
        await this.sendAndPersist({ type: "PAUSE", reason: "loop_paused" });
        return;
      }
      const stepId = `loop-verify:${iteration}`;
      const decision = await this.options.verifyHost({
        iteration,
        stepId,
        candidate: this.outputs.get("candidate")?.text ?? "",
      });
      if (this.controller.phase !== "verifying") return;
      this.saveOutput("verification", {
        text: decision.feedback,
        metadata: { agent: "host", stepId },
      });
      this.options.emit({
        type: "step_output",
        stepId,
        agent: "host",
        text: decision.feedback,
        saveAs: "verification",
      });
      await this.sendAndPersist({ type: "VERIFIED", passed: decision.decision === "accept" });
      return;
    }
    const output = await this.runStep(
      "verify",
      `loop-verify:${iteration}`,
      verification.agent,
      this.interpolate(verification.input),
      "verification",
    );
    this.saveOutput("verification", output);
    const condition = this.interpolate(verification.passIf, output.text);
    const textPassed = evalCondition(condition);
    const evidencePassed = this.options.verifyEvidence
      ? await this.options.verifyEvidence({
          iteration,
          stepId: `loop-verify:${iteration}`,
          textPassed,
        })
      : true;
    await this.sendAndPersist({ type: "VERIFIED", passed: textPassed && evidencePassed });
  }

  private async runRepair(): Promise<void> {
    const repair = this.options.loop.repair;
    const repairCount = this.controller.getSnapshot().repairCount;
    this.variables.set("repairs", String(repairCount));
    const output = await this.runStep(
      "repair",
      `loop-repair:${repairCount}`,
      repair.agent,
      this.interpolate(repair.input),
      "candidate",
    );
    this.saveOutput("candidate", output);
    await this.sendAndPersist({ type: "REPAIRED", fingerprint: progressFingerprint(output.text) });
  }

  private async runStep(
    kind: LoopStepKind,
    stepId: string,
    agent: string,
    input: string,
    saveAs: string,
  ): Promise<StepOutput> {
    const completed =
      this.completedSteps.get(stepId) ??
      (() => {
        const legacy = legacyStepId(stepId);
        return legacy ? this.completedSteps.get(legacy) : undefined;
      })();
    if (completed) {
      this.options.emit({ type: "step_resumed", stepId });
      if (completed.saveAs) this.saveOutput(completed.saveAs, completed.output);
      return completed.output;
    }

    this.options.emit({ type: "step_start", stepId, kind: `loop_${kind}` });
    try {
      const text = await this.options.executeStep({ kind, stepId, agent, input });
      const output: StepOutput = { text, metadata: { agent, stepId } };
      this.options.emit({ type: "step_output", stepId, agent, text, saveAs });
      this.options.emit({ type: "step_end", stepId, ok: true });
      return output;
    } catch (error) {
      this.options.emit({ type: "step_end", stepId, ok: false });
      throw error;
    }
  }

  private saveOutput(name: string, output: StepOutput): void {
    this.outputs.set(name, output);
    this.variables.set(name, output.text);
    this.variables.set(`${name}.text`, output.text);
  }

  private interpolate(template: string, verificationText?: string): string {
    return template.replace(INTERPOLATE_RE, (match, name: string) => {
      if (name === "text" && verificationText !== undefined) return verificationText;
      return this.variables.get(name) ?? match;
    });
  }

  private async sendAndPersist(event: LoopControllerEvent): Promise<void> {
    const before = this.controller.phase;
    this.controller.send(event);
    if (this.controller.phase !== before) {
      await this.options.persistSnapshot(this.controller.getSnapshot());
    }
  }

  private async recordExecutionError(error: CoreMindError): Promise<void> {
    if (isTerminal(this.controller.phase)) return;
    const code = error.code;
    const message = error.message;
    const category = classifyRetry(error).category;
    if (category === "human") {
      await this.sendAndPersist({ type: "PAUSE", reason: code });
      return;
    }
    switch (cancelSignalForCode(code)) {
      case "abort":
        await this.sendAndPersist({ type: "ABORT" });
        break;
      case "timeout":
        await this.sendAndPersist({ type: "TIMEOUT" });
        break;
      case "budget_exceeded":
        await this.sendAndPersist({ type: "BUDGET_EXCEEDED" });
        break;
      default:
        await this.sendAndPersist({ type: "FAIL", code, message });
    }
  }

  private result(error?: unknown): LoopRunResult {
    const transcript = this.outputs.get("candidate")?.text ?? "";
    return {
      outputs: new Map(this.outputs),
      transcript,
      snapshot: this.controller.getSnapshot(),
      ...(error !== undefined ? { error } : {}),
    };
  }
}

function isTerminal(phase: string): boolean {
  return ["succeeded", "failed", "aborted", "timeout", "budget_exceeded"].includes(phase);
}

function terminalError(snapshot: LoopControllerSnapshot): CoreMindError | undefined {
  if (snapshot.phase === "succeeded") return undefined;
  if (snapshot.phase === "paused") {
    return new CoreMindError("loop_paused", snapshot.pauseReason ?? "Loop 已暂停");
  }
  const code = snapshot.failureCode ?? "loop_failed";
  return new CoreMindError(
    isErrorCode(code) ? code : "unclassified_error",
    snapshot.failureMessage ?? `Loop 以 ${snapshot.phase} 结束`,
  );
}

function errorForCaller(error: unknown, snapshot: LoopControllerSnapshot): unknown {
  if (snapshot.phase === "paused") {
    if (error instanceof CoreMindError && error.code === "unclassified_error") return error;
    return terminalError(snapshot);
  }
  return error;
}

function progressFingerprint(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}
