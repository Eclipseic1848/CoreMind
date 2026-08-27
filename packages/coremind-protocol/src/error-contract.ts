/**
 * CoreMind 跨语言错误合同的单一事实源。
 *
 * 所有取消/终态/恢复/损坏语义的分类都在 ERROR_CODES 中声明；
 * retry-policy、run-terminalizer、loop-runner 的分类只引用本模块，不再维护自有字符串集合。
 * 规格见 docs/spec/0.3.x-a/03-cancellation-and-quiescence.md §2。
 */

/** 终态性：terminal=终态、pausable=可暂停恢复、transient=可重试瞬态 */
export type ErrorTerminality = "terminal" | "pausable" | "transient";

/**
 * 取消分类：cancel=外部中止、timeout=超时、budget=预算/限制、
 * human=需人工处置、corruption=数据/配置损坏、other=非取消类错误
 */
export type ErrorCancelClass = "cancel" | "timeout" | "budget" | "human" | "corruption" | "other";

/** 重试分类：human=需人工处置不可重试、transient=可安全重试、fatal=确定性失败 */
export type ErrorRetryClass = "human" | "transient" | "fatal";

/** 人工处置分类：required=继续前必须人工处置、none=不要求人工介入 */
export type ErrorHumanAction = "required" | "none";

export interface ErrorCodeInfo {
  terminality: ErrorTerminality;
  cancelClass: ErrorCancelClass;
  retryClass: ErrorRetryClass;
  humanAction: ErrorHumanAction;
}

type ErrorCodeBaseInfo = Omit<ErrorCodeInfo, "humanAction">;

type ErrorCodeRegistry<T extends Readonly<Record<string, ErrorCodeBaseInfo>>> = {
  readonly [Code in keyof T]: T[Code] & {
    readonly humanAction: T[Code]["retryClass"] extends "human" ? "required" : "none";
  };
};

function defineErrorCodes<const T extends Readonly<Record<string, ErrorCodeBaseInfo>>>(
  codes: T,
): ErrorCodeRegistry<T> {
  return Object.fromEntries(
    Object.entries(codes).map(([code, info]) => [
      code,
      { ...info, humanAction: info.retryClass === "human" ? "required" : "none" },
    ]),
  ) as ErrorCodeRegistry<T>;
}

/**
 * 错误码码表：键为对外错误码字符串（0.3.0 起保持稳定），值为三个正交分类属性。
 * "other" 是规格外历史码的中性取消分类（规格 03 枚举之外的兜底）。
 */
export const ERROR_CODES = defineErrorCodes({
  // —— 取消类（cancel / timeout / budget）——
  aborted: { terminality: "terminal", cancelClass: "cancel", retryClass: "fatal" },
  run_timeout: { terminality: "terminal", cancelClass: "timeout", retryClass: "fatal" },
  step_timeout: { terminality: "terminal", cancelClass: "timeout", retryClass: "fatal" },
  budget_exceeded: { terminality: "terminal", cancelClass: "budget", retryClass: "fatal" },
  retry_limit: { terminality: "terminal", cancelClass: "budget", retryClass: "fatal" },
  step_limit: { terminality: "terminal", cancelClass: "budget", retryClass: "fatal" },

  // —— 暂停/人工类 ——
  approval_denied: { terminality: "pausable", cancelClass: "human", retryClass: "human" },
  tool_approval_denied: { terminality: "pausable", cancelClass: "human", retryClass: "human" },
  policy_denied: { terminality: "pausable", cancelClass: "human", retryClass: "human" },
  loop_paused: { terminality: "pausable", cancelClass: "human", retryClass: "human" },
  unknown_effect: { terminality: "pausable", cancelClass: "human", retryClass: "human" },
  committed_effect_pending: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },
  context_budget_exhausted: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },
  context_capability_conflict: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },
  context_artifact_missing: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },
  unclassified_error: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },

  // —— 恢复类 ——
  resume_input_mismatch: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  resume_config_mismatch: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  run_already_finished: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  operation_not_resumable: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  unknown_run: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  run_state_failed: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  durability_unsupported: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  durability_barrier_failed: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  fact_ledger_poisoned: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  fact_ledger_terminal: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  workspace_lease_recovery_required: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },
  child_run_orphan_audit_required: {
    terminality: "pausable",
    cancelClass: "human",
    retryClass: "human",
  },
  child_run_parent_mismatch: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  child_run_adapter_failed: {
    terminality: "terminal",
    cancelClass: "other",
    retryClass: "fatal",
  },
  child_run_policy_escalation: {
    terminality: "terminal",
    cancelClass: "human",
    retryClass: "fatal",
  },
  child_run_concurrency_limit: {
    terminality: "terminal",
    cancelClass: "budget",
    retryClass: "fatal",
  },
  child_run_identity_mismatch: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  child_run_not_quiescent: {
    terminality: "pausable",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  child_run_unavailable: {
    terminality: "terminal",
    cancelClass: "human",
    retryClass: "fatal",
  },

  // —— 损坏类 ——
  run_state_corrupt: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  run_state_conflict: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  run_state_locked: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_corrupt: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_conflict: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_failed: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_not_found: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  checkpoint_too_large: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  checkpoint_not_reversible: {
    terminality: "terminal",
    cancelClass: "other",
    retryClass: "fatal",
  },
  invalid_checkpoint_id: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  loop_snapshot_invalid: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  loop_snapshot_mismatch: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  loop_config_invalid: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  loop_state_invalid: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  operation_state_corrupt: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  invalid_operation_state: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  invalid_operation_transition: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  control_invalid: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  control_run_mismatch: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_migration_invalid: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_layout_conflict: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  invalid_session_id: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_restore_failed: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_migration_conflict: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_migration_failed: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_migration_unsupported: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_alias_failed: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  session_open_locked: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  invalid_run_id: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  invalid_config: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  invalid_tool: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  tool_capability_conflict: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  tool_lifecycle_invalid: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  effect_receipt_conflict: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  workspace_lease_invalid: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  workspace_lease_not_quiescent: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  environment_terminate_failed: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  context_lineage_corrupt: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  delegation_conflict: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },

  // —— 瞬态类 ——
  network_error: { terminality: "transient", cancelClass: "other", retryClass: "transient" },
  provider_unavailable: {
    terminality: "transient",
    cancelClass: "other",
    retryClass: "transient",
  },
  provider_timeout: { terminality: "transient", cancelClass: "other", retryClass: "transient" },
  provider_transient: { terminality: "transient", cancelClass: "other", retryClass: "transient" },
  rate_limit: { terminality: "transient", cancelClass: "other", retryClass: "transient" },
  workspace_busy: { terminality: "transient", cancelClass: "other", retryClass: "transient" },

  // —— worker 类 ——
  worker_closed: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  already_initialized: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  worker_busy: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  duplicate_tool: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  duplicate_tool_call: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  unknown_tool_call: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  python_tool_failed: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  unknown_approval: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  not_initialized: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  concurrent_run: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  control_unavailable: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },

  // —— 其他 ——
  unknown_agent: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  unknown_provider: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  agent_failed: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  no_agent: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  no_prompt: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  no_models: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  loop_failed: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  loop_exhausted: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  loop_no_progress: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  verification_failed: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  retry_exhausted: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  quality_override_audit_failed: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  cursor_ahead: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  cursor_expired: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  run_id_conflict: {
    terminality: "terminal",
    cancelClass: "corruption",
    retryClass: "fatal",
  },
  protocol_validation_failed: {
    terminality: "terminal",
    cancelClass: "other",
    retryClass: "fatal",
  },
  protocol_version_mixed: {
    terminality: "terminal",
    cancelClass: "other",
    retryClass: "fatal",
  },
  protocol_version_unsupported: {
    terminality: "terminal",
    cancelClass: "other",
    retryClass: "fatal",
  },
  parse_error: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  internal_error: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  unknown: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
} as const satisfies Record<string, ErrorCodeBaseInfo>);

/** Error Contract 中登记的稳定公开错误码。 */
export type ErrorCode = keyof typeof ERROR_CODES;

/** 外部错误码归一化结果；原始值仅供后续脱敏审计，不是公开错误码。 */
export interface NormalizedExternalErrorCode {
  code: ErrorCode;
  audit?: {
    originalCode: string;
  };
}

/** 判断一个值是否为已登记的稳定错误码。 */
export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.hasOwn(ERROR_CODES, code);
}

/** 把未知外部错误码收敛到唯一的失败关闭合同。 */
export function normalizeExternalErrorCode(code: string): NormalizedExternalErrorCode {
  if (isErrorCode(code)) return { code };
  return {
    code: "unclassified_error",
    audit: { originalCode: code },
  };
}
