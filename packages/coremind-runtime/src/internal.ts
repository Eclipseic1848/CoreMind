// 仅供同仓库受控组件复用；不属于 coremind-runtime 主公共入口。
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
