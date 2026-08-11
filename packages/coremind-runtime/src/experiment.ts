import { createHash } from "node:crypto";
import type { EvaluationGraderResult } from "./evaluation.js";
import type { RunMetrics, RunOutcome } from "./result.js";
import type { CoreMindTraceEvent } from "./trace.js";

export interface ExperimentArm {
  id: string;
  weight: number;
  config?: Readonly<Record<string, unknown>>;
}

export interface ExperimentDefinition {
  id: string;
  version: string;
  seed: string;
  arms: readonly ExperimentArm[];
}

export interface ExperimentSelection {
  armId: string;
  sample: number;
  assignmentHash: string;
  config?: Readonly<Record<string, unknown>>;
}

export interface ExperimentEnvironment {
  platform: string;
  runtimeVersion: string;
  provider: string;
  model: string;
  [key: string]: string | number | boolean;
}

export interface ExperimentRunEvidence {
  runId: string;
  outcome: RunOutcome;
  metrics: RunMetrics;
  approvalCount: number;
  trace: CoreMindTraceEvent[];
  graderResults: EvaluationGraderResult[];
}

export interface ExperimentRecord {
  schemaVersion: 1;
  experiment: { id: string; version: string; seed: string };
  selection: ExperimentSelection;
  inputFingerprint: string;
  environment: ExperimentEnvironment;
  startedAt: string;
  finishedAt: string;
  run: ExperimentRunEvidence;
}

export type ExperimentErrorCode = "experiment_invalid" | "experiment_run_invalid";

export class ExperimentError extends Error {
  constructor(
    readonly code: ExperimentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExperimentError";
  }
}

export function defineExperiment(definition: ExperimentDefinition): ExperimentDefinition {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(definition.id)) {
    throw new ExperimentError("experiment_invalid", `实验 id 无效：${definition.id}`);
  }
  if (!definition.version.trim() || !definition.seed.trim()) {
    throw new ExperimentError("experiment_invalid", "实验必须声明非空版本与 seed");
  }
  if (definition.arms.length < 1) {
    throw new ExperimentError("experiment_invalid", "实验至少需要一个 arm");
  }
  const ids = new Set<string>();
  const arms = definition.arms.map((arm) => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(arm.id) || ids.has(arm.id)) {
      throw new ExperimentError("experiment_invalid", `arm id 无效或重复：${arm.id}`);
    }
    if (!Number.isFinite(arm.weight) || arm.weight <= 0) {
      throw new ExperimentError("experiment_invalid", `arm ${arm.id} 权重必须大于 0`);
    }
    ids.add(arm.id);
    return Object.freeze({
      ...arm,
      ...(arm.config ? { config: Object.freeze(structuredClone(arm.config)) } : {}),
    });
  });
  return Object.freeze({
    id: definition.id,
    version: definition.version.trim(),
    seed: definition.seed,
    arms: Object.freeze(arms),
  });
}

export function selectExperimentArm(
  definition: ExperimentDefinition,
  inputFingerprint: string,
): ExperimentSelection {
  if (!inputFingerprint.trim()) {
    throw new ExperimentError("experiment_invalid", "实验输入指纹不能为空");
  }
  const assignmentHash = createHash("sha256")
    .update(
      `${definition.id}\0${definition.version}\0${definition.seed}\0${inputFingerprint}`,
      "utf8",
    )
    .digest("hex");
  const sample = Number.parseInt(assignmentHash.slice(0, 13), 16) / 0x10_0000_0000_0000;
  const totalWeight = definition.arms.reduce((sum, arm) => sum + arm.weight, 0);
  let cursor = sample * totalWeight;
  let selected = definition.arms.at(-1)!;
  for (const arm of definition.arms) {
    cursor -= arm.weight;
    if (cursor < 0) {
      selected = arm;
      break;
    }
  }
  return {
    armId: selected.id,
    sample,
    assignmentHash,
    ...(selected.config ? { config: selected.config } : {}),
  };
}

export async function runExperiment(options: {
  definition: ExperimentDefinition;
  inputFingerprint: string;
  environment: ExperimentEnvironment;
  run: (arm: ExperimentArm) => Promise<ExperimentRunEvidence>;
}): Promise<ExperimentRecord> {
  const definition = defineExperiment(options.definition);
  const selection = selectExperimentArm(definition, options.inputFingerprint);
  const arm = definition.arms.find((candidate) => candidate.id === selection.armId)!;
  const startedAt = new Date().toISOString();
  const run = await options.run(arm);
  validateRunEvidence(run);
  return {
    schemaVersion: 1,
    experiment: {
      id: definition.id,
      version: definition.version,
      seed: definition.seed,
    },
    selection,
    inputFingerprint: options.inputFingerprint,
    environment: structuredClone(options.environment),
    startedAt,
    finishedAt: new Date().toISOString(),
    run: structuredClone(run),
  };
}

function validateRunEvidence(run: ExperimentRunEvidence): void {
  if (!run.runId.trim() || !Number.isInteger(run.approvalCount) || run.approvalCount < 0) {
    throw new ExperimentError("experiment_run_invalid", "实验运行必须包含 runId 和非负审批次数");
  }
  if (run.trace.some((entry) => entry.runId !== run.runId)) {
    throw new ExperimentError("experiment_run_invalid", "实验 Trace 含有与 runId 不一致的记录");
  }
}
