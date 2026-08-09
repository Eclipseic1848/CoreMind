import { type ActorRefFrom, assign, createActor, setup } from "xstate";
import { CoreMindError } from "./errors.js";

export type LoopPhase =
  | "idle"
  | "planning"
  | "executing"
  | "verifying"
  | "repairing"
  | "paused"
  | "succeeded"
  | "failed"
  | "aborted"
  | "timeout"
  | "budget_exceeded";

export type LoopFailureStrategy = "repair" | "pause" | "fail";
export type LoopExhaustedStrategy = "pause" | "fail";

export interface LoopControllerConfig {
  runId: string;
  configFingerprint: string;
  hasPlanning: boolean;
  maxIterations: number;
  maxRepairs: number;
  maxRepeatedAction: number;
  onFailure: LoopFailureStrategy;
  onExhausted: LoopExhaustedStrategy;
}

export type LoopControllerEvent =
  | { type: "START" }
  | { type: "PLANNED" }
  | { type: "EXECUTED"; fingerprint: string }
  | { type: "VERIFIED"; passed: boolean }
  | { type: "REPAIRED"; fingerprint: string }
  | { type: "PAUSE"; reason: string }
  | { type: "RESUME" }
  | { type: "ABORT" }
  | { type: "TIMEOUT" }
  | { type: "BUDGET_EXCEEDED" }
  | { type: "FAIL"; code: string; message: string };

export interface LoopControllerSnapshot {
  schemaVersion: 1;
  machineVersion: "1";
  runId: string;
  configFingerprint: string;
  phase: LoopPhase;
  iteration: number;
  repairCount: number;
  repeatedActionCount: number;
  transitionSequence: number;
  lastActionFingerprint?: string;
  pauseReason?: string;
  resumePhase?: Exclude<LoopPhase, "paused">;
  failureCode?: string;
  failureMessage?: string;
}

export interface LoopTransition {
  sequence: number;
  event: LoopControllerEvent["type"];
  from: LoopPhase;
  to: LoopPhase;
  snapshot: LoopControllerSnapshot;
}

interface LoopContext {
  iteration: number;
  repairCount: number;
  repeatedActionCount: number;
  lastActionFingerprint?: string;
  pauseReason?: string;
  resumePhase?: Exclude<LoopPhase, "paused">;
  failureCode?: string;
  failureMessage?: string;
}

const LOOP_MACHINE_VERSION = "1" as const;
const LOOP_PHASES: ReadonlySet<string> = new Set([
  "idle",
  "planning",
  "executing",
  "verifying",
  "repairing",
  "paused",
  "succeeded",
  "failed",
  "aborted",
  "timeout",
  "budget_exceeded",
]);
const TERMINAL_PHASES: ReadonlySet<LoopPhase> = new Set([
  "succeeded",
  "failed",
  "aborted",
  "timeout",
  "budget_exceeded",
]);

function createLoopMachine(config: LoopControllerConfig) {
  return setup({
    types: {
      context: {} as LoopContext,
      events: {} as LoopControllerEvent,
    },
    guards: {
      hasPlanning: () => config.hasPlanning,
      verificationPassed: ({ event }) => event.type === "VERIFIED" && event.passed,
      repairLimitExhausted: ({ context }) =>
        context.iteration >= config.maxIterations || context.repairCount >= config.maxRepairs,
      failOnVerification: () => config.onFailure === "fail",
      pauseOnVerification: () => config.onFailure === "pause",
      repeatedActionExhausted: ({ context, event }) =>
        hasFingerprint(event) &&
        nextRepeatedCount(context, event.fingerprint) >= config.maxRepeatedAction,
      pauseForRepeatedAction: ({ context, event }) =>
        hasFingerprint(event) &&
        nextRepeatedCount(context, event.fingerprint) >= config.maxRepeatedAction &&
        config.onExhausted === "pause",
      resumePlanning: ({ context }) => context.resumePhase === "planning",
      resumeExecuting: ({ context }) => context.resumePhase === "executing",
      resumeVerifying: ({ context }) => context.resumePhase === "verifying",
      resumeRepairing: ({ context }) => context.resumePhase === "repairing",
    },
    actions: {
      recordExecution: assign(({ context, event }) => {
        const execution = event as Extract<LoopControllerEvent, { type: "EXECUTED" }>;
        return {
          ...recordFingerprint(context, execution.fingerprint),
          iteration: context.iteration + 1,
        };
      }),
      recordRepair: assign(({ context, event }) => {
        const repair = event as Extract<LoopControllerEvent, { type: "REPAIRED" }>;
        return {
          ...recordFingerprint(context, repair.fingerprint),
          iteration: context.iteration + 1,
        };
      }),
      countRepair: assign(({ context }) => ({ repairCount: context.repairCount + 1 })),
      pauseFromPlanning: assign(({ event }) => pauseContext(event, "planning")),
      pauseFromExecuting: assign(({ event }) => pauseContext(event, "executing")),
      pauseFromVerifying: assign(({ event }) => pauseContext(event, "verifying")),
      pauseFromRepairing: assign(({ event }) => pauseContext(event, "repairing")),
      pauseForVerification: assign(({ context }) => ({
        pauseReason: "verification_failed",
        resumePhase: "repairing" as const,
        repairCount: context.repairCount + 1,
      })),
      pauseForExhaustion: assign({
        pauseReason: "loop_exhausted",
        resumePhase: undefined,
        failureCode: "loop_exhausted",
        failureMessage: "Loop 已达到迭代或修复上限",
      }),
      pauseForNoProgress: assign(({ context, event }) => {
        const action = event as Extract<LoopControllerEvent, { type: "EXECUTED" | "REPAIRED" }>;
        return {
          ...recordFingerprint(context, action.fingerprint),
          pauseReason: "loop_no_progress",
          resumePhase: undefined,
          failureCode: "loop_no_progress",
          failureMessage: "Loop 重复相同动作，未检测到进展",
        };
      }),
      failForExhaustion: assign({
        failureCode: "loop_exhausted",
        failureMessage: "Loop 已达到迭代或修复上限",
      }),
      failForNoProgress: assign(({ context, event }) => {
        const action = event as Extract<LoopControllerEvent, { type: "EXECUTED" | "REPAIRED" }>;
        return {
          ...recordFingerprint(context, action.fingerprint),
          failureCode: "loop_no_progress",
          failureMessage: "Loop 重复相同动作，未检测到进展",
        };
      }),
      failForVerification: assign({
        failureCode: "verification_failed",
        failureMessage: "验证未通过，配置要求立即失败",
      }),
      markAborted: assign({
        failureCode: "aborted",
        failureMessage: "执行已中止",
      }),
      markTimeout: assign({
        failureCode: "run_timeout",
        failureMessage: "Loop 执行超时",
      }),
      markBudgetExceeded: assign({
        failureCode: "budget_exceeded",
        failureMessage: "Loop 已耗尽运行预算",
      }),
      markFailure: assign(({ event }) => {
        const failure = event as Extract<LoopControllerEvent, { type: "FAIL" }>;
        return { failureCode: failure.code, failureMessage: failure.message };
      }),
      clearPause: assign({ pauseReason: undefined, resumePhase: undefined }),
    },
  }).createMachine({
    id: "coremind-loop",
    initial: "idle",
    context: {
      iteration: 0,
      repairCount: 0,
      repeatedActionCount: 0,
    },
    on: {
      ABORT: { target: ".aborted", actions: "markAborted" },
      TIMEOUT: { target: ".timeout", actions: "markTimeout" },
      BUDGET_EXCEEDED: { target: ".budget_exceeded", actions: "markBudgetExceeded" },
      FAIL: { target: ".failed", actions: "markFailure" },
    },
    states: {
      idle: {
        on: {
          START: [{ guard: "hasPlanning", target: "planning" }, { target: "executing" }],
        },
      },
      planning: {
        on: {
          PLANNED: "executing",
          PAUSE: { target: "paused", actions: "pauseFromPlanning" },
        },
      },
      executing: {
        on: {
          EXECUTED: [
            {
              guard: "pauseForRepeatedAction",
              target: "paused",
              actions: "pauseForNoProgress",
            },
            {
              guard: ({ context, event }) =>
                event.type === "EXECUTED" &&
                nextRepeatedCount(context, event.fingerprint) >= config.maxRepeatedAction &&
                config.onExhausted === "fail",
              target: "failed",
              actions: "failForNoProgress",
            },
            { target: "verifying", actions: "recordExecution" },
          ],
          PAUSE: { target: "paused", actions: "pauseFromExecuting" },
        },
      },
      verifying: {
        on: {
          VERIFIED: [
            { guard: "verificationPassed", target: "succeeded" },
            {
              guard: ({ context }) =>
                (context.iteration >= config.maxIterations ||
                  context.repairCount >= config.maxRepairs) &&
                config.onExhausted === "pause",
              target: "paused",
              actions: "pauseForExhaustion",
            },
            {
              guard: "repairLimitExhausted",
              target: "failed",
              actions: "failForExhaustion",
            },
            {
              guard: "failOnVerification",
              target: "failed",
              actions: "failForVerification",
            },
            {
              guard: "pauseOnVerification",
              target: "paused",
              actions: "pauseForVerification",
            },
            { target: "repairing", actions: "countRepair" },
          ],
          PAUSE: { target: "paused", actions: "pauseFromVerifying" },
        },
      },
      repairing: {
        on: {
          REPAIRED: [
            {
              guard: ({ context, event }) =>
                event.type === "REPAIRED" &&
                nextRepeatedCount(context, event.fingerprint) >= config.maxRepeatedAction &&
                config.onExhausted === "pause",
              target: "paused",
              actions: "pauseForNoProgress",
            },
            {
              guard: "repeatedActionExhausted",
              target: "failed",
              actions: "failForNoProgress",
            },
            { target: "verifying", actions: "recordRepair" },
          ],
          PAUSE: { target: "paused", actions: "pauseFromRepairing" },
        },
      },
      paused: {
        on: {
          RESUME: [
            { guard: "resumePlanning", target: "planning", actions: "clearPause" },
            { guard: "resumeExecuting", target: "executing", actions: "clearPause" },
            { guard: "resumeVerifying", target: "verifying", actions: "clearPause" },
            { guard: "resumeRepairing", target: "repairing", actions: "clearPause" },
          ],
        },
      },
      succeeded: { type: "final" },
      failed: { type: "final" },
      aborted: { type: "final" },
      timeout: { type: "final" },
      budget_exceeded: { type: "final" },
    },
  });
}

type LoopActor = ActorRefFrom<ReturnType<typeof createLoopMachine>>;

/** XState 只存在于此适配器内部；调用方只读写 CoreMind 的领域事件和版本化快照。 */
export class LoopController {
  readonly config: LoopControllerConfig;
  private readonly actor: LoopActor;
  private transitionSequence: number;
  private readonly listeners = new Set<(event: LoopTransition) => void>();

  constructor(config: LoopControllerConfig, snapshot?: LoopControllerSnapshot) {
    validateConfig(config);
    this.config = { ...config };
    const machine = createLoopMachine(config);
    this.transitionSequence = snapshot?.transitionSequence ?? 0;
    this.actor = snapshot
      ? createActor(machine, {
          snapshot: machine.resolveState({
            value: snapshot.phase,
            context: contextFromSnapshot(snapshot),
            status: TERMINAL_PHASES.has(snapshot.phase) ? "done" : "active",
          }),
        })
      : createActor(machine);
    this.actor.start();
  }

  static restore(config: LoopControllerConfig, snapshot: LoopControllerSnapshot): LoopController {
    validateSnapshot(config, snapshot);
    return new LoopController(config, snapshot);
  }

  get phase(): LoopPhase {
    return this.actor.getSnapshot().value as LoopPhase;
  }

  send(event: LoopControllerEvent): void {
    const from = this.phase;
    this.actor.send(event);
    const to = this.phase;
    if (from === to) return;
    this.transitionSequence += 1;
    const transition: LoopTransition = {
      sequence: this.transitionSequence,
      event: event.type,
      from,
      to,
      snapshot: this.getSnapshot(),
    };
    for (const listener of this.listeners) listener(transition);
  }

  subscribe(listener: (event: LoopTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): LoopControllerSnapshot {
    const context = this.actor.getSnapshot().context;
    return {
      schemaVersion: 1,
      machineVersion: LOOP_MACHINE_VERSION,
      runId: this.config.runId,
      configFingerprint: this.config.configFingerprint,
      phase: this.phase,
      iteration: context.iteration,
      repairCount: context.repairCount,
      repeatedActionCount: context.repeatedActionCount,
      transitionSequence: this.transitionSequence,
      ...(context.lastActionFingerprint !== undefined
        ? { lastActionFingerprint: context.lastActionFingerprint }
        : {}),
      ...(context.pauseReason !== undefined ? { pauseReason: context.pauseReason } : {}),
      ...(context.resumePhase !== undefined ? { resumePhase: context.resumePhase } : {}),
      ...(context.failureCode !== undefined ? { failureCode: context.failureCode } : {}),
      ...(context.failureMessage !== undefined ? { failureMessage: context.failureMessage } : {}),
    };
  }
}

function hasFingerprint(
  event: LoopControllerEvent,
): event is Extract<LoopControllerEvent, { type: "EXECUTED" | "REPAIRED" }> {
  return event.type === "EXECUTED" || event.type === "REPAIRED";
}

function nextRepeatedCount(context: LoopContext, fingerprint: string): number {
  return context.lastActionFingerprint === fingerprint ? context.repeatedActionCount + 1 : 1;
}

function recordFingerprint(context: LoopContext, fingerprint: string): Partial<LoopContext> {
  return {
    lastActionFingerprint: fingerprint,
    repeatedActionCount: nextRepeatedCount(context, fingerprint),
  };
}

function pauseContext(
  event: LoopControllerEvent,
  resumePhase: Exclude<LoopPhase, "paused">,
): Partial<LoopContext> {
  const pause = event as Extract<LoopControllerEvent, { type: "PAUSE" }>;
  return { pauseReason: pause.reason, resumePhase };
}

function contextFromSnapshot(snapshot: LoopControllerSnapshot): LoopContext {
  return {
    iteration: snapshot.iteration,
    repairCount: snapshot.repairCount,
    repeatedActionCount: snapshot.repeatedActionCount,
    ...(snapshot.lastActionFingerprint !== undefined
      ? { lastActionFingerprint: snapshot.lastActionFingerprint }
      : {}),
    ...(snapshot.pauseReason !== undefined ? { pauseReason: snapshot.pauseReason } : {}),
    ...(snapshot.resumePhase !== undefined ? { resumePhase: snapshot.resumePhase } : {}),
    ...(snapshot.failureCode !== undefined ? { failureCode: snapshot.failureCode } : {}),
    ...(snapshot.failureMessage !== undefined ? { failureMessage: snapshot.failureMessage } : {}),
  };
}

function validateConfig(config: LoopControllerConfig): void {
  if (!config.runId || !config.configFingerprint) {
    throw new CoreMindError("loop_config_invalid", "LoopController 缺少 runId 或配置指纹");
  }
  if (
    !Number.isInteger(config.maxIterations) ||
    config.maxIterations < 1 ||
    !Number.isInteger(config.maxRepairs) ||
    config.maxRepairs < 0 ||
    !Number.isInteger(config.maxRepeatedAction) ||
    config.maxRepeatedAction < 1
  ) {
    throw new CoreMindError("loop_config_invalid", "LoopController 的迭代和修复上限无效");
  }
}

function validateSnapshot(config: LoopControllerConfig, snapshot: LoopControllerSnapshot): void {
  if (snapshot.schemaVersion !== 1 || snapshot.machineVersion !== LOOP_MACHINE_VERSION) {
    throw new CoreMindError("loop_snapshot_invalid", "Loop 快照版本不受支持");
  }
  if (snapshot.runId !== config.runId) {
    throw new CoreMindError("loop_snapshot_mismatch", "Loop 快照 runId 与当前运行不匹配");
  }
  if (snapshot.configFingerprint !== config.configFingerprint) {
    throw new CoreMindError("loop_snapshot_mismatch", "Loop 快照配置指纹与当前配置不匹配");
  }
  if (
    !LOOP_PHASES.has(snapshot.phase) ||
    !nonNegativeInteger(snapshot.iteration) ||
    !nonNegativeInteger(snapshot.repairCount) ||
    !nonNegativeInteger(snapshot.repeatedActionCount) ||
    !nonNegativeInteger(snapshot.transitionSequence)
  ) {
    throw new CoreMindError("loop_snapshot_invalid", "Loop 快照内容无效");
  }
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
