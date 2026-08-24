// 统一门面的内部入口；只转发同仓库组件需要的 Runtime 投影能力。
export {
  type ContextProjection,
  type PendingApprovalControl,
  ProjectionEngine,
  type RecoveryDecision,
  RunContext,
  RunKernel,
  type RunKernelDependency,
  type RunProjection,
  type RunProjectionStatus,
} from "coremind-runtime/internal";
