// 仅供同仓库受控组件复用；不属于 coremind-runtime 主公共入口。
export {
  CompactionLedger,
  type ContextArtifactReference,
  type ContextCapabilityCandidate,
  type ContextCapabilityConfidence,
  type ContextCapabilityEvidence,
  type ContextCapabilitySource,
  type ContextCompactionLedgerEntry,
  type ContextCompactionPreparation,
  type ContextCompactionTrigger,
  ContextLifecycleError,
  type ContextLifecycleErrorCode,
  type ContextLifecycleFailureReason,
  ContextLifecycleManager,
  type ContextLifecyclePreparation,
  type ContextLifecyclePrepareInput,
  type ContextLifecycleRequest,
  type ContextRequestBudget,
  type ContextTaskState,
  type ContextTaskStateSourceFacts,
  type ContextWorkingSet,
  ContextWorkingSetBuilder,
  type ContextWorkingSetBuildResult,
  type ResolvedContextCapability,
} from "./context-lifecycle.js";
export {
  type ContextPlanStep,
  type ContextTaskStateProjectionInput,
  projectContextTaskState,
} from "./context-task-state.js";
export {
  type ContextProjection,
  type PendingApprovalControl,
  ProjectionEngine,
  type RecoveryDecision,
  type RunProjection,
  type RunProjectionStatus,
} from "./projection.js";
export { RunContext } from "./run-context.js";
export { RunKernel, type RunKernelDependency } from "./run-kernel.js";
