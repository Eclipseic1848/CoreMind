import type {
  ChildRunExecutionAdapter,
  ChildRunExecutionInput,
  ChildRunResult,
} from "./child-run.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindRuntime, RunResult } from "./runtime.js";
import { isRegisteredCoreMindRuntimeInstance } from "./runtime-instance-authority.js";

const CORE_MIND_CHILD_RUN_ADAPTER = Symbol("CoreMindChildRunAdapter");

export interface CoreMindChildRunAdapter extends ChildRunExecutionAdapter {
  readonly [CORE_MIND_CHILD_RUN_ADAPTER]: true;
}

export interface CoreMindChildRunAdapterOptions {
  createRuntime(input: ChildRunExecutionInput): Promise<CoreMindRuntime>;
  quiescenceTimeoutMs?: number;
}

/**
 * 把 Child Run 合同桥接到独立 CoreMindRuntime；工厂必须把 input.signal、childRunId 与
 * inheritedPolicy 映射进 Runtime 配置，不能在桥接层放宽权限或预算。
 */
export function createCoreMindChildRunAdapter(
  options: CoreMindChildRunAdapterOptions,
): CoreMindChildRunAdapter {
  return Object.freeze({
    [CORE_MIND_CHILD_RUN_ADAPTER]: true as const,
    execute: async (input: ChildRunExecutionInput) => {
      const runtime = await options.createRuntime(input);
      if (!isRegisteredCoreMindRuntimeInstance(runtime)) {
        throw new CoreMindError(
          "child_run_identity_mismatch",
          "Child Runtime 必须是由 CoreMindRuntime.create 创建的真实独立实例",
        );
      }
      await runtime.verifyChildRunAuthority(input);
      const result = await runtime.run();
      if (result.runId !== input.childRunId) {
        throw new CoreMindError(
          "child_run_identity_mismatch",
          `Child Runtime 返回 RunId ${result.runId}，期望 ${input.childRunId}`,
        );
      }
      if (!(await runtime.waitForQuiescence(options.quiescenceTimeoutMs))) {
        throw new CoreMindError(
          "child_run_not_quiescent",
          `Child Run ${input.childRunId} 在终态后仍未静止`,
        );
      }
      return childRunResultFromRuntime(result);
    },
  });
}

export function isCoreMindChildRunAdapter(
  value: ChildRunExecutionAdapter,
): value is CoreMindChildRunAdapter {
  return (value as Partial<CoreMindChildRunAdapter>)[CORE_MIND_CHILD_RUN_ADAPTER] === true;
}

function childRunResultFromRuntime(result: RunResult): ChildRunResult {
  const checkpointReferences = result.checkpoints.map(
    (checkpoint) => `checkpoint:${checkpoint.checkpointId}`,
  );
  return {
    outcome: structuredClone(result.outcome),
    evidence: [...result.trace.map((entry) => `event:${entry.eventId}`), ...checkpointReferences],
    artifacts: (result.artifacts ?? result.snapshot.artifacts).map(
      (artifact) => artifact.artifactId,
    ),
    workspaceChanges: checkpointReferences,
    unresolvedRisks:
      result.outcome.error === undefined ? [] : [structuredClone(result.outcome.error.message)],
  };
}
