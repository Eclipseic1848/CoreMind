// 统一门面的内部入口；只转发同仓库组件需要的 Runtime 投影能力。
export {
  buildProviderRuntime,
  type ContextProjection,
  ControlInbox,
  classifyExecutionError,
  enforceExecutionSecurity,
  type InternalRunControlCommand,
  type PendingApprovalControl,
  ProjectionEngine,
  type RecoveryDecision,
  RunContext,
  type RunId,
  RunKernel,
  type RunKernelDependency,
  type RunProjection,
  type RunProjectionStatus,
  resolveProviderSecurity,
} from "coremind-runtime/internal";
