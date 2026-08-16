/**
 * CoreMind 错误码单一事实源。
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

export interface ErrorCodeInfo {
  terminality: ErrorTerminality;
  cancelClass: ErrorCancelClass;
  retryClass: ErrorRetryClass;
}

/**
 * 错误码码表：键为对外错误码字符串（0.3.0 起保持稳定），值为三个正交分类属性。
 * "other" 是规格外历史码的中性取消分类（规格 03 枚举之外的兜底）。
 */
export const ERROR_CODES = {
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

  // —— 恢复类 ——
  resume_input_mismatch: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  resume_config_mismatch: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  run_already_finished: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  operation_not_resumable: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  unknown_run: { terminality: "terminal", cancelClass: "human", retryClass: "fatal" },
  run_state_failed: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },

  // —— 损坏类 ——
  run_state_corrupt: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  run_state_conflict: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  run_state_locked: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_corrupt: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_conflict: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_failed: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  checkpoint_not_found: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  checkpoint_too_large: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
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
  invalid_run_id: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  invalid_config: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },
  invalid_tool: { terminality: "terminal", cancelClass: "corruption", retryClass: "fatal" },

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

  // —— 其他 ——
  unknown_agent: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  agent_failed: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  no_models: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
  unknown: { terminality: "terminal", cancelClass: "other", retryClass: "fatal" },
} as const satisfies Record<string, ErrorCodeInfo>;

/** 从码表派生终态映射（替代 run-terminalizer 的自有 statusFromCode 字符串集合）。 */
export function terminalStatusForCode(
  code: string,
): "paused" | "aborted" | "timeout" | "budget_exceeded" | "failed" {
  if (code === "loop_paused") return "paused";
  const info = codeInfo(code);
  if (info === undefined) return "failed";
  switch (info.cancelClass) {
    case "cancel":
      return "aborted";
    case "timeout":
      return "timeout";
    case "budget":
      return "budget_exceeded";
    default:
      return "failed";
  }
}

/** 从码表派生 Loop 控制器信号（替代 loop-runner 的自有映射字符串集合）。 */
export function cancelSignalForCode(
  code: string,
): "abort" | "timeout" | "budget_exceeded" | "pause" | "fail" {
  const info = codeInfo(code);
  if (info === undefined) return "fail";
  if (info.retryClass === "human") return "pause";
  switch (info.cancelClass) {
    case "cancel":
      return "abort";
    case "timeout":
      return "timeout";
    case "budget":
      return "budget_exceeded";
    default:
      return "fail";
  }
}

function codeInfo(code: string): ErrorCodeInfo | undefined {
  return (ERROR_CODES as Readonly<Record<string, ErrorCodeInfo>>)[code];
}

/** 查询码表的重试分类（替代 retry-policy 的自有 HUMAN_CODES / TRANSIENT_CODES 集合）。 */
export function retryClassForCode(code: string): ErrorRetryClass | undefined {
  return codeInfo(code)?.retryClass;
}

/** CoreMind 运行时错误（带错误码，便于 CLI 与库调用方区分处理） */
export class CoreMindError extends Error {
  /** 机器可读错误码；分类语义见 ERROR_CODES 码表 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoreMindError";
    this.code = code;
  }
}
