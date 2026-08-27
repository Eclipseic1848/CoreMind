import { Static } from '@sinclair/typebox';
import { TArray } from '@sinclair/typebox';
import { TBoolean } from '@sinclair/typebox';
import { TInteger } from '@sinclair/typebox';
import { TLiteral } from '@sinclair/typebox';
import { TNull } from '@sinclair/typebox';
import { TNumber } from '@sinclair/typebox';
import { TObject } from '@sinclair/typebox';
import { TOptional } from '@sinclair/typebox';
import { TRecord } from '@sinclair/typebox';
import { TString } from '@sinclair/typebox';
import { TUnion } from '@sinclair/typebox';
import { TUnknown } from '@sinclair/typebox';
import { TUnsafe } from '@sinclair/typebox';

export declare const ApproveRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"approve">;
params: TObject<    {
runId: TString;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>;
}>;

export declare const CancelRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"cancel">;
params: TObject<    {
runId: TString;
}>;
}>;

export declare const ChatRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
agent: TString;
message: TString;
runId: TOptional<TString>;
}>;
}>;

export declare const CheckpointDiffRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_diff">;
params: TObject<    {
runId: TString;
checkpointId: TString;
}>;
}>;

export declare const CheckpointRestoreRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_restore">;
params: TObject<    {
runId: TString;
checkpointId: TString;
confirm: TLiteral<true>;
}>;
}>;

export declare const CloseRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"close">;
params: TObject<    {}>;
}>;

export declare function createErrorResponse(id: RpcId, code: number, message: string, coremindCode?: ErrorCode, details?: unknown): ProtocolErrorResponse;

export declare function createEventNotification(params: Omit<ProtocolEventNotification["params"], "protocolVersion">): ProtocolEventNotification;

export declare function createPythonToolCallNotification(params: Omit<PythonToolCallNotification["params"], "protocolVersion">): PythonToolCallNotification;

export declare function createSuccessResponse(id: RpcId, result: unknown): ProtocolSuccessResponse;

/**
 * 错误码码表：键为对外错误码字符串（0.3.0 起保持稳定），值为三个正交分类属性。
 * "other" 是规格外历史码的中性取消分类（规格 03 枚举之外的兜底）。
 */
export declare const ERROR_CODES: ErrorCodeRegistry<{
    readonly aborted: {
        readonly terminality: "terminal";
        readonly cancelClass: "cancel";
        readonly retryClass: "fatal";
    };
    readonly run_timeout: {
        readonly terminality: "terminal";
        readonly cancelClass: "timeout";
        readonly retryClass: "fatal";
    };
    readonly step_timeout: {
        readonly terminality: "terminal";
        readonly cancelClass: "timeout";
        readonly retryClass: "fatal";
    };
    readonly budget_exceeded: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly retry_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly step_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly approval_denied: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly tool_approval_denied: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly tool_execution_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly policy_denied: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly loop_paused: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly unknown_effect: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly committed_effect_pending: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly context_budget_exhausted: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly context_capability_conflict: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly context_artifact_missing: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly unclassified_error: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly resume_input_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly resume_config_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly run_already_finished: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly operation_not_resumable: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly unknown_run: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly run_state_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly durability_unsupported: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly durability_barrier_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly fact_ledger_poisoned: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly fact_ledger_terminal: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly workspace_lease_recovery_required: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly child_run_orphan_audit_required: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
        readonly runStatus: "paused";
    };
    readonly child_run_parent_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly child_run_adapter_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly child_run_policy_escalation: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly child_run_concurrency_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly child_run_identity_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly child_run_not_quiescent: {
        readonly terminality: "pausable";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly child_run_unavailable: {
        readonly terminality: "terminal";
        readonly cancelClass: "human";
        readonly retryClass: "fatal";
    };
    readonly run_state_corrupt: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly run_state_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly run_state_locked: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly checkpoint_corrupt: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly checkpoint_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly checkpoint_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly checkpoint_not_found: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly checkpoint_too_large: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly checkpoint_not_reversible: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly invalid_checkpoint_id: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly loop_snapshot_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly loop_snapshot_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly loop_config_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly loop_state_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly operation_state_corrupt: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_operation_state: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_operation_transition: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly control_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly control_run_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_migration_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_layout_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_session_id: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_restore_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_migration_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_migration_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_migration_unsupported: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_alias_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly session_open_locked: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_run_id: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_config: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_tool: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly tool_capability_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly tool_lifecycle_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly effect_receipt_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly workspace_lease_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly workspace_lease_not_quiescent: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly environment_terminate_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly context_lineage_corrupt: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly delegation_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly network_error: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly provider_unavailable: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly provider_timeout: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly provider_transient: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly rate_limit: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly workspace_busy: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly worker_closed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly already_initialized: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly worker_busy: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly duplicate_tool: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly duplicate_tool_call: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly unknown_tool_call: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly python_tool_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly unknown_approval: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly not_initialized: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly concurrent_run: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly control_unavailable: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly unknown_agent: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly unknown_provider: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly agent_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly no_agent: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly no_prompt: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly no_models: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly loop_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly loop_exhausted: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly loop_no_progress: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly verification_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly retry_exhausted: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly quality_override_audit_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly cursor_ahead: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly cursor_expired: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly run_id_conflict: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly protocol_validation_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly protocol_version_mixed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly protocol_version_unsupported: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly protocol_capability_missing: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly protocol_version_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly invalid_run_handle: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_event_page: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_projection_query: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_control_receipt: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_run_snapshot: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly invalid_observability: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly parse_error: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly internal_error: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly coding_choice_required: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly coding_invalid_choice: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly coding_invalid_change: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly coding_verification_claim_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly coding_delivery_not_verified: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly experiment_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly experiment_run_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly extension_invalid: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly extension_duplicate: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly extension_not_trusted: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly extension_capability_denied: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly dns: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly tls: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly http_401: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly http_429: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly timeout: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly exporter_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly exporter_unavailable: {
        readonly terminality: "transient";
        readonly cancelClass: "other";
        readonly retryClass: "transient";
    };
    readonly egress_policy_missing: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly egress_policy_denied: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly configuration_mismatch: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly feedback_consent_missing: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly content_consent_missing: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly redaction_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly environment_probe_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly environment_capability_mismatch: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly environment_requirement_unsatisfied: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly environment_activity_conflict: {
        readonly terminality: "pausable";
        readonly cancelClass: "human";
        readonly retryClass: "human";
    };
    readonly git_command_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly git_invalid_request: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly git_path_outside_workspace: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly process_timeout: {
        readonly terminality: "terminal";
        readonly cancelClass: "timeout";
        readonly retryClass: "fatal";
    };
    readonly process_aborted: {
        readonly terminality: "terminal";
        readonly cancelClass: "cancel";
        readonly retryClass: "fatal";
    };
    readonly process_output_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly process_spawn_failed: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
    readonly diff_complexity_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly diff_input_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly diff_output_limit: {
        readonly terminality: "terminal";
        readonly cancelClass: "budget";
        readonly retryClass: "fatal";
    };
    readonly diff_path_outside_workspace: {
        readonly terminality: "terminal";
        readonly cancelClass: "corruption";
        readonly retryClass: "fatal";
    };
    readonly unknown: {
        readonly terminality: "terminal";
        readonly cancelClass: "other";
        readonly retryClass: "fatal";
    };
}>;

/**
 * 取消分类：cancel=外部中止、timeout=超时、budget=预算/限制、
 * human=需人工处置、corruption=数据/配置损坏、other=非取消类错误
 */
export declare type ErrorCancelClass = "cancel" | "timeout" | "budget" | "human" | "corruption" | "other";

/** Error Contract 中登记的稳定公开错误码。 */
export declare type ErrorCode = keyof typeof ERROR_CODES;

declare type ErrorCodeBaseInfo = Omit<ErrorCodeInfo, "humanAction" | "runStatus"> & {
    runStatus?: ErrorRunStatus;
};

export declare interface ErrorCodeInfo {
    /** 错误自身是否可恢复；不等同于 expand 阶段保留的既有 Run 输出。 */
    terminality: ErrorTerminality;
    cancelClass: ErrorCancelClass;
    retryClass: ErrorRetryClass;
    humanAction: ErrorHumanAction;
    /** 既有 Run 输出的兼容投影；可能暂时与 terminality 不同，迁移时必须显式改合同。 */
    runStatus: ErrorRunStatus;
}

declare type ErrorCodeRegistry<T extends Readonly<Record<string, ErrorCodeBaseInfo>>> = {
    readonly [Code in keyof T]: T[Code] & {
        readonly humanAction: T[Code]["retryClass"] extends "human" ? "required" : "none";
        readonly runStatus: ErrorRunStatus;
    };
};

/** 由唯一注册表派生，供 Protocol v1/v2 与公共类型共同复用。 */
export declare const ErrorCodeSchema: TUnsafe<"timeout" | "aborted" | "budget_exceeded" | "run_timeout" | "step_timeout" | "retry_limit" | "step_limit" | "approval_denied" | "tool_approval_denied" | "tool_execution_failed" | "policy_denied" | "loop_paused" | "unknown_effect" | "committed_effect_pending" | "context_budget_exhausted" | "context_capability_conflict" | "context_artifact_missing" | "unclassified_error" | "resume_input_mismatch" | "resume_config_mismatch" | "run_already_finished" | "operation_not_resumable" | "unknown_run" | "run_state_failed" | "durability_unsupported" | "durability_barrier_failed" | "fact_ledger_poisoned" | "fact_ledger_terminal" | "workspace_lease_recovery_required" | "child_run_orphan_audit_required" | "child_run_parent_mismatch" | "child_run_adapter_failed" | "child_run_policy_escalation" | "child_run_concurrency_limit" | "child_run_identity_mismatch" | "child_run_not_quiescent" | "child_run_unavailable" | "run_state_corrupt" | "run_state_conflict" | "run_state_locked" | "checkpoint_corrupt" | "checkpoint_conflict" | "checkpoint_failed" | "checkpoint_not_found" | "checkpoint_too_large" | "checkpoint_not_reversible" | "invalid_checkpoint_id" | "loop_snapshot_invalid" | "loop_snapshot_mismatch" | "loop_config_invalid" | "loop_state_invalid" | "operation_state_corrupt" | "invalid_operation_state" | "invalid_operation_transition" | "control_invalid" | "control_run_mismatch" | "session_migration_invalid" | "session_layout_conflict" | "invalid_session_id" | "session_restore_failed" | "session_migration_conflict" | "session_migration_failed" | "session_migration_unsupported" | "session_alias_failed" | "session_open_locked" | "invalid_run_id" | "invalid_config" | "invalid_tool" | "tool_capability_conflict" | "tool_lifecycle_invalid" | "effect_receipt_conflict" | "workspace_lease_invalid" | "workspace_lease_not_quiescent" | "environment_terminate_failed" | "context_lineage_corrupt" | "delegation_conflict" | "network_error" | "provider_unavailable" | "provider_timeout" | "provider_transient" | "rate_limit" | "workspace_busy" | "worker_closed" | "already_initialized" | "worker_busy" | "duplicate_tool" | "duplicate_tool_call" | "unknown_tool_call" | "python_tool_failed" | "unknown_approval" | "not_initialized" | "concurrent_run" | "control_unavailable" | "unknown_agent" | "unknown_provider" | "agent_failed" | "no_agent" | "no_prompt" | "no_models" | "loop_failed" | "loop_exhausted" | "loop_no_progress" | "verification_failed" | "retry_exhausted" | "quality_override_audit_failed" | "cursor_ahead" | "cursor_expired" | "run_id_conflict" | "protocol_validation_failed" | "protocol_version_mixed" | "protocol_version_unsupported" | "protocol_capability_missing" | "protocol_version_mismatch" | "invalid_run_handle" | "invalid_event_page" | "invalid_projection_query" | "invalid_control_receipt" | "invalid_run_snapshot" | "invalid_observability" | "parse_error" | "internal_error" | "coding_choice_required" | "coding_invalid_choice" | "coding_invalid_change" | "coding_verification_claim_mismatch" | "coding_delivery_not_verified" | "experiment_invalid" | "experiment_run_invalid" | "extension_invalid" | "extension_duplicate" | "extension_not_trusted" | "extension_capability_denied" | "dns" | "tls" | "http_401" | "http_429" | "exporter_failed" | "exporter_unavailable" | "egress_policy_missing" | "egress_policy_denied" | "configuration_mismatch" | "feedback_consent_missing" | "content_consent_missing" | "redaction_failed" | "environment_probe_failed" | "environment_capability_mismatch" | "environment_requirement_unsatisfied" | "environment_activity_conflict" | "git_command_failed" | "git_invalid_request" | "git_path_outside_workspace" | "process_timeout" | "process_aborted" | "process_output_limit" | "process_spawn_failed" | "diff_complexity_limit" | "diff_input_limit" | "diff_output_limit" | "diff_path_outside_workspace" | "unknown">;

/** 人工处置分类：required=继续前必须人工处置、none=不要求人工介入 */
export declare type ErrorHumanAction = "required" | "none";

/** 重试分类：human=需人工处置不可重试、transient=可安全重试、fatal=确定性失败 */
export declare type ErrorRetryClass = "human" | "transient" | "fatal";

/** 当前公开 Run 终态；expand 阶段保留既有输出，后续迁移只能在合同变更下调整。 */
export declare type ErrorRunStatus = "paused" | "aborted" | "timeout" | "budget_exceeded" | "failed";

/**
 * CoreMind 跨语言错误合同的单一事实源。
 *
 * 所有取消/终态/恢复/损坏语义的分类都在 ERROR_CODES 中声明；
 * retry-policy、run-terminalizer、loop-runner 的分类只引用本模块，不再维护自有字符串集合。
 * 规格见 docs/spec/0.3.x-a/03-cancellation-and-quiescence.md §2。
 */
/** 终态性：terminal=终态、pausable=可暂停恢复、transient=可重试瞬态 */
export declare type ErrorTerminality = "terminal" | "pausable" | "transient";

export declare type InitializeRequest = Static<typeof InitializeRequestSchema>;

export declare const InitializeRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"initialize">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
config: TOptional<TUnknown>;
configPath: TOptional<TString>;
configDir: TOptional<TString>;
cwd: TOptional<TString>;
sessionId: TOptional<TString>;
}>;
}>;

export declare const InspectRunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"inspect_run">;
params: TObject<    {
runId: TString;
}>;
}>;

/** 判断一个值是否为已登记的稳定错误码。 */
export declare function isErrorCode(code: unknown): code is ErrorCode;

/** 从客户端显式范围中选择 Host 当前唯一支持的 v2 版本。 */
export declare function negotiateProtocolV2(range: ProtocolVersionRange): typeof PROTOCOL_V2_VERSION;

/** 外部错误码归一化结果；原始值仅供后续脱敏审计，不是公开错误码。 */
export declare interface NormalizedExternalErrorCode {
    code: ErrorCode;
    audit?: {
        originalCode: string;
    };
}

/** 把未知外部错误码收敛到唯一的失败关闭合同。 */
export declare function normalizeExternalErrorCode(code: string): NormalizedExternalErrorCode;

export declare function parseProtocolRequest(value: unknown): ProtocolRequest;

/** 解析 v2 请求；连接级版本锁定由 ProtocolHost 负责。 */
export declare function parseProtocolV2Request(value: unknown): ProtocolV2Request;

export declare function parseRunSnapshot(value: unknown): ProtocolRunSnapshot;

/** 客户端与 Host 共同锁定的完整 v2 线协议 schema 集。 */
export declare const PROTOCOL_V2_SCHEMA_BUNDLE: {
    readonly request: TUnion<[TObject<    {
    jsonrpc: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"initialize">;
    params: TObject<    {
    protocolRange: TObject<    {
    minVersion: TString;
    maxVersion: TString;
    }>;
    capabilities: TOptional<TArray<TString>>;
    config: TOptional<TUnknown>;
    configPath: TOptional<TString>;
    configDir: TOptional<TString>;
    cwd: TOptional<TString>;
    sessionId: TOptional<TString>;
    }>;
    }>, TObject<    {
    jsonrpc: TLiteral<"2.0">;
    protocolVersion: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"run">;
    params: TObject<    {
    runId: TString;
    input: TOptional<TString>;
    }>;
    }>, TObject<    {
    jsonrpc: TLiteral<"2.0">;
    protocolVersion: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"chat">;
    params: TObject<    {
    runId: TString;
    agent: TString;
    message: TString;
    }>;
    }>, TObject<    {
    jsonrpc: TLiteral<"2.0">;
    protocolVersion: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"resume">;
    params: TObject<    {
    runId: TString;
    input: TOptional<TString>;
    }>;
    }>, TObject<    {
    jsonrpc: TLiteral<"2.0">;
    protocolVersion: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"control">;
    params: TUnion<[TObject<    {
    runId: TString;
    schemaVersion: TLiteral<1>;
    controlId: TString;
    type: TLiteral<"cancel">;
    reason: TOptional<TString>;
    }>, TObject<    {
    runId: TString;
    schemaVersion: TLiteral<1>;
    controlId: TString;
    type: TLiteral<"approval">;
    approvalId: TString;
    decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
    }>, TObject<    {
    runId: TString;
    schemaVersion: TLiteral<1>;
    controlId: TString;
    type: TLiteral<"steering">;
    message: TString;
    }>, TObject<    {
    runId: TString;
    schemaVersion: TLiteral<1>;
    controlId: TString;
    type: TLiteral<"follow_up">;
    message: TString;
    }>]>;
    }>, TObject<    {
    jsonrpc: TLiteral<"2.0">;
    protocolVersion: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"events">;
    params: TObject<    {
    runId: TString;
    afterSequence: TInteger;
    limit: TOptional<TInteger>;
    }>;
    }>, TObject<    {
    jsonrpc: TLiteral<"2.0">;
    protocolVersion: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    method: TLiteral<"query">;
    params: TObject<    {
    runId: TString;
    }>;
    }>]>;
    readonly initializeResult: TObject<    {
    selectedProtocol: TLiteral<"2.0">;
    runtime: TLiteral<"node">;
    warnings: TArray<TString>;
    serverCapabilities: TArray<TString>;
    schemaFingerprint: TString;
    migration: TObject<    {
    v1Supported: TBoolean;
    v1SupportedThrough: TString;
    earliestRemoval: TString;
    }>;
    }>;
    readonly runHandle: TObject<    {
    runId: TString;
    acceptedAt: TString;
    initialCursor: TLiteral<0>;
    selectedProtocol: TLiteral<"2.0">;
    availableControls: TArray<TUnion<[TLiteral<"cancel">, TLiteral<"approval">, TLiteral<"steering">, TLiteral<"follow_up">]>>;
    }>;
    readonly eventEnvelope: TUnion<[...TObject<    {
    runId: TString;
    approvalId: TOptional<TString>;
    protocolVersion: TLiteral<"2.0">;
    eventSchemaVersion: TLiteral<1>;
    sequence: TInteger;
    eventId: TString;
    timestamp: TString;
    turnId: TOptional<TString>;
    stepId: TOptional<TString>;
    callId: TOptional<TString>;
    receiptId: TOptional<TString>;
    parentRunId: TOptional<TString>;
    childRunId: TOptional<TString>;
    delegationId: TOptional<TString>;
    ignorable: TBoolean;
    sensitivity: TLiteral<"local">;
    eventType: TLiteral<"budget_exceeded" | "policy_denied" | "capability_resolved" | "approval_resolved" | "agent_start" | "turn_end" | "text_delta" | "tool_call" | "tool_result" | "tool_attempt" | "workspace_lease" | "effect_receipt" | "step_start" | "step_output" | "step_resumed" | "step_end" | "loop_state" | "retry" | "approval_required" | "context_budget_resolved" | "context_compacted" | "context_compaction_failed" | "context_lifecycle_failed" | "context_prefix" | "provider_request" | "artifact_created" | "extension_lifecycle" | "error" | "checkpoint_created" | "tool_execution_evidence" | "engineering_evidence" | "agent_end" | "input_receipt" | "input_claimed" | "input_completed" | "input_discarded" | "quiescence_timeout" | "tool_lifecycle">;
    payload: TObject<    {
    type: TLiteral<"agent_start">;
    agent: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"turn_end">;
    agent: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    tokens: TOptional<TNumber>;
    inputTokens: TOptional<TNumber>;
    outputTokens: TOptional<TNumber>;
    cacheReadTokens: TOptional<TNumber>;
    cacheWriteTokens: TOptional<TNumber>;
    promptCacheStatus: TOptional<TUnion<[TLiteral<"available">, TLiteral<"unavailable">]>>;
    costUsd: TOptional<TNumber>;
    requestsAnotherTurn: TOptional<TBoolean>;
    }> | TObject<    {
    type: TLiteral<"text_delta">;
    agent: TString;
    delta: TString;
    stepId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"tool_call">;
    agent: TString;
    tool: TString;
    args: TUnknown;
    argumentsFingerprint: TOptional<TString>;
    callId: TOptional<TString>;
    idempotencyKey: TOptional<TString>;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"tool_result">;
    agent: TString;
    tool: TString;
    isError: TBoolean;
    callId: TOptional<TString>;
    idempotencyKey: TOptional<TString>;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"tool_attempt">;
    attemptId: TString;
    previousReceiptId: TString;
    attempt: TInteger;
    agent: TString;
    tool: TString;
    callId: TString;
    stepId: TOptional<TString>;
    argumentsFingerprint: TString;
    }> | TObject<    {
    type: TLiteral<"capability_resolved">;
    agent: TString;
    tool: TString;
    callId: TString;
    stepId: TOptional<TString>;
    capability: TObject<    {
    tool: TString;
    effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
    replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
    concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
    checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
    durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
    source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
    resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
    issues: TArray<TString>;
    }>;
    recoveryDisposition: TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>;
    }> | TObject<    {
    type: TLiteral<"workspace_lease">;
    status: TUnion<[TLiteral<"acquired">, TLiteral<"released">, TLiteral<"recovery_required">]>;
    canonicalRoot: TString;
    lane: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
    owner: TObject<    {
    runId: TString;
    callId: TString;
    pid: TInteger;
    }>;
    agent: TString;
    callId: TString;
    stepId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"effect_receipt">;
    idempotencyKey: TString;
    tool: TString;
    status: TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>;
    agent: TOptional<TString>;
    callId: TOptional<TString>;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    binding: TOptional<TObject<    {
    version: TLiteral<1>;
    runId: TString;
    turnId: TString;
    agent: TString;
    stepId: TOptional<TString>;
    callId: TString;
    tool: TString;
    argumentsFingerprint: TString;
    capabilityFingerprint: TString;
    }>>;
    }> | TObject<    {
    type: TLiteral<"step_start">;
    stepId: TString;
    kind: TString;
    }> | TObject<    {
    type: TLiteral<"step_output">;
    stepId: TString;
    agent: TString;
    text: TString;
    saveAs: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"step_resumed">;
    stepId: TString;
    }> | TObject<    {
    type: TLiteral<"step_end">;
    stepId: TString;
    ok: TBoolean;
    }> | TObject<    {
    type: TLiteral<"loop_state">;
    from: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
    to: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
    trigger: TString;
    iteration: TInteger;
    repairs: TInteger;
    reason: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"retry">;
    scope: TUnion<[TLiteral<"provider">, TLiteral<"workflow">]>;
    attempt: TInteger;
    stepId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"approval_required">;
    approvalId: TString;
    runId: TString;
    agent: TString;
    tool: TString;
    args: TUnknown;
    risk: TUnion<[TLiteral<"low">, TLiteral<"high">]>;
    effect: TObject<    {
    operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
    paths: TArray<TString>;
    urls: TArray<TString>;
    reversible: TBoolean;
    declared: TBoolean;
    }>;
    capability: TOptional<TObject<    {
    tool: TString;
    effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
    replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
    concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
    checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
    durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
    source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
    resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
    issues: TArray<TString>;
    }>>;
    }> | TObject<    {
    type: TLiteral<"approval_resolved">;
    approvalId: TString;
    runId: TString;
    decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
    }> | TObject<    {
    type: TLiteral<"policy_denied">;
    agent: TString;
    tool: TString;
    reason: TString;
    }> | TObject<    {
    type: TLiteral<"budget_exceeded">;
    dimension: TUnion<[TLiteral<"turns">, TLiteral<"toolCalls">, TLiteral<"toolFailures">, TLiteral<"tokens">, TLiteral<"costUsd">]>;
    limit: TNumber;
    actual: TNumber;
    message: TString;
    }> | TObject<    {
    type: TLiteral<"context_budget_resolved">;
    providerId: TString;
    modelId: TString;
    capabilityFingerprint: TString;
    source: TUnion<[TLiteral<"locked_catalog">, TLiteral<"explicit_config">, TLiteral<"provider_metadata">, TLiteral<"conservative_fallback">]>;
    confidence: TUnion<[TLiteral<"verified">, TLiteral<"declared">, TLiteral<"assumed">]>;
    effectiveContextWindow: TNumber;
    reservedOutputTokens: TNumber;
    availableInputTokens: TNumber;
    messageTokens: TNumber;
    stablePrefixTokens: TNumber;
    toolSchemaTokens: TNumber;
    structuredOutputTokens: TNumber;
    multimodalTokens: TNumber;
    protocolOverheadTokens: TNumber;
    safetyMarginTokens: TNumber;
    estimator: TLiteral<"pi-agent-core-estimate-v1">;
    evidence: TArray<TUnion<[TLiteral<"safe_context_intersection">, TLiteral<"assumed_context_window">]>>;
    }> | TObject<    {
    type: TLiteral<"context_compacted">;
    beforeTokens: TNumber;
    afterTokens: TNumber;
    removedMessages: TNumber;
    strategy: TUnion<[TLiteral<"deterministic-v1">, TLiteral<"task-state-v1">]>;
    reason: TLiteral<"threshold">;
    summaryFingerprint: TString;
    capabilityFingerprint: TOptional<TString>;
    lineageDepth: TOptional<TNumber>;
    rebuiltFromCanonical: TOptional<TBoolean>;
    trigger: TOptional<TUnion<[TLiteral<"threshold">, TLiteral<"model_switch">, TLiteral<"provider_overflow">]>>;
    sessionEntryId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"context_compaction_failed">;
    message: TString;
    preservedMessages: TNumber;
    }> | TObject<    {
    type: TLiteral<"context_lifecycle_failed">;
    code: TUnion<[TLiteral<"context_capability_conflict">, TLiteral<"context_budget_exhausted">, TLiteral<"context_artifact_missing">, TLiteral<"context_lineage_corrupt">]>;
    reason: TString;
    pausable: TBoolean;
    preservedMessages: TNumber;
    providerCallBlocked: TLiteral<true>;
    }> | TObject<    {
    type: TLiteral<"context_prefix">;
    agent: TString;
    fingerprint: TString;
    }> | TObject<    {
    type: TLiteral<"provider_request">;
    requestId: TString;
    agent: TString;
    stepId: TOptional<TString>;
    providerId: TString;
    modelId: TString;
    messageFingerprint: TString;
    stablePrefixFingerprint: TString;
    toolSchemaFingerprint: TString;
    capabilityFingerprint: TString;
    contextWorkingSetFingerprint: TString;
    }> | TObject<    {
    type: TLiteral<"artifact_created">;
    artifactId: TString;
    status: TUnion<[TLiteral<"stored">, TLiteral<"blocked">]>;
    sizeBytes: TNumber;
    relativePath: TOptional<TString>;
    sha256: TOptional<TString>;
    mediaType: TString;
    redaction: TUnion<[TLiteral<"none">, TLiteral<"blocked-secret">]>;
    tool: TString;
    callId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"extension_lifecycle">;
    extensionId: TString;
    extensionVersion: TString;
    lifecycle: TUnion<[TLiteral<"before-model">, TLiteral<"before-tool">, TLiteral<"after-tool">, TLiteral<"run-finished">]>;
    status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"timed_out">]>;
    durationMs: TNumber;
    error: TOptional<TString>;
    denied: TOptional<TBoolean>;
    }> | TObject<    {
    type: TLiteral<"checkpoint_created">;
    checkpointId: TString;
    tool: TString;
    callId: TOptional<TString>;
    idempotencyKey: TOptional<TString>;
    targetPath: TOptional<TString>;
    reversible: TBoolean;
    }> | TObject<    {
    type: TLiteral<"tool_execution_evidence">;
    agent: TString;
    tool: TString;
    callId: TString;
    stepId: TOptional<TString>;
    execution: TObject<    {
    durationMs: TNumber;
    exitCode: TUnion<[TInteger, TNull]>;
    commandSha256: TOptional<TString>;
    testCommand: TOptional<TBoolean>;
    }>;
    }> | TObject<    {
    type: TLiteral<"engineering_evidence">;
    stepId: TString;
    textPassed: TBoolean;
    passed: TBoolean;
    successfulTestCommands: TInteger;
    regressionCommandMatched: TBoolean;
    checkpointRecorded: TBoolean;
    diffReviewed: TBoolean;
    reasons: TArray<TString>;
    }> | TObject<    {
    type: TLiteral<"agent_end">;
    agent: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"error">;
    message: TString;
    fatal: TBoolean;
    }> | TObject<    {
    type: TLiteral<"input_receipt">;
    inputId: TString;
    status: TLiteral<"pending">;
    contentFingerprint: TString;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"input_claimed">;
    inputId: TString;
    status: TLiteral<"claimed">;
    turnId: TString;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"input_completed">;
    inputId: TString;
    status: TLiteral<"completed">;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"input_discarded">;
    inputId: TString;
    status: TLiteral<"discarded">;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"quiescence_timeout">;
    timeoutMs: TNumber;
    }> | TObject<    {
    type: TLiteral<"tool_lifecycle">;
    agent: TString;
    callId: TString;
    tool: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    resolution: TUnion<[TObject<    {
    phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
    status: TLiteral<"completed">;
    result: TOptional<TObject<    {
    executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
    effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
    persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
    recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
    cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
    authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
    environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
    }>>;
    }>, TObject<    {
    phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
    status: TUnion<[TLiteral<"skipped">, TLiteral<"failed">]>;
    reason: TString;
    result: TOptional<TObject<    {
    executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
    effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
    persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
    recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
    cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
    authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
    environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
    }>>;
    }>]>;
    }>;
    }>[], TObject<    {
    runId: TString;
    approvalId: TOptional<TString>;
    protocolVersion: TLiteral<"2.0">;
    eventSchemaVersion: TLiteral<1>;
    sequence: TInteger;
    eventId: TString;
    timestamp: TString;
    turnId: TOptional<TString>;
    stepId: TOptional<TString>;
    callId: TOptional<TString>;
    receiptId: TOptional<TString>;
    parentRunId: TOptional<TString>;
    childRunId: TOptional<TString>;
    delegationId: TOptional<TString>;
    ignorable: TBoolean;
    sensitivity: TLiteral<"local">;
    eventType: TString;
    payload: TUnknown;
    }>]>;
    readonly eventPage: TObject<    {
    schemaVersion: TLiteral<1>;
    runId: TString;
    afterSequence: TInteger;
    nextCursor: TInteger;
    hasMore: TBoolean;
    events: TArray<TUnion<[...TObject<    {
    runId: TString;
    approvalId: TOptional<TString>;
    protocolVersion: TLiteral<"2.0">;
    eventSchemaVersion: TLiteral<1>;
    sequence: TInteger;
    eventId: TString;
    timestamp: TString;
    turnId: TOptional<TString>;
    stepId: TOptional<TString>;
    callId: TOptional<TString>;
    receiptId: TOptional<TString>;
    parentRunId: TOptional<TString>;
    childRunId: TOptional<TString>;
    delegationId: TOptional<TString>;
    ignorable: TBoolean;
    sensitivity: TLiteral<"local">;
    eventType: TLiteral<"budget_exceeded" | "policy_denied" | "capability_resolved" | "approval_resolved" | "agent_start" | "turn_end" | "text_delta" | "tool_call" | "tool_result" | "tool_attempt" | "workspace_lease" | "effect_receipt" | "step_start" | "step_output" | "step_resumed" | "step_end" | "loop_state" | "retry" | "approval_required" | "context_budget_resolved" | "context_compacted" | "context_compaction_failed" | "context_lifecycle_failed" | "context_prefix" | "provider_request" | "artifact_created" | "extension_lifecycle" | "error" | "checkpoint_created" | "tool_execution_evidence" | "engineering_evidence" | "agent_end" | "input_receipt" | "input_claimed" | "input_completed" | "input_discarded" | "quiescence_timeout" | "tool_lifecycle">;
    payload: TObject<    {
    type: TLiteral<"agent_start">;
    agent: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"turn_end">;
    agent: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    tokens: TOptional<TNumber>;
    inputTokens: TOptional<TNumber>;
    outputTokens: TOptional<TNumber>;
    cacheReadTokens: TOptional<TNumber>;
    cacheWriteTokens: TOptional<TNumber>;
    promptCacheStatus: TOptional<TUnion<[TLiteral<"available">, TLiteral<"unavailable">]>>;
    costUsd: TOptional<TNumber>;
    requestsAnotherTurn: TOptional<TBoolean>;
    }> | TObject<    {
    type: TLiteral<"text_delta">;
    agent: TString;
    delta: TString;
    stepId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"tool_call">;
    agent: TString;
    tool: TString;
    args: TUnknown;
    argumentsFingerprint: TOptional<TString>;
    callId: TOptional<TString>;
    idempotencyKey: TOptional<TString>;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"tool_result">;
    agent: TString;
    tool: TString;
    isError: TBoolean;
    callId: TOptional<TString>;
    idempotencyKey: TOptional<TString>;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"tool_attempt">;
    attemptId: TString;
    previousReceiptId: TString;
    attempt: TInteger;
    agent: TString;
    tool: TString;
    callId: TString;
    stepId: TOptional<TString>;
    argumentsFingerprint: TString;
    }> | TObject<    {
    type: TLiteral<"capability_resolved">;
    agent: TString;
    tool: TString;
    callId: TString;
    stepId: TOptional<TString>;
    capability: TObject<    {
    tool: TString;
    effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
    replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
    concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
    checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
    durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
    source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
    resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
    issues: TArray<TString>;
    }>;
    recoveryDisposition: TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>;
    }> | TObject<    {
    type: TLiteral<"workspace_lease">;
    status: TUnion<[TLiteral<"acquired">, TLiteral<"released">, TLiteral<"recovery_required">]>;
    canonicalRoot: TString;
    lane: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
    owner: TObject<    {
    runId: TString;
    callId: TString;
    pid: TInteger;
    }>;
    agent: TString;
    callId: TString;
    stepId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"effect_receipt">;
    idempotencyKey: TString;
    tool: TString;
    status: TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>;
    agent: TOptional<TString>;
    callId: TOptional<TString>;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    binding: TOptional<TObject<    {
    version: TLiteral<1>;
    runId: TString;
    turnId: TString;
    agent: TString;
    stepId: TOptional<TString>;
    callId: TString;
    tool: TString;
    argumentsFingerprint: TString;
    capabilityFingerprint: TString;
    }>>;
    }> | TObject<    {
    type: TLiteral<"step_start">;
    stepId: TString;
    kind: TString;
    }> | TObject<    {
    type: TLiteral<"step_output">;
    stepId: TString;
    agent: TString;
    text: TString;
    saveAs: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"step_resumed">;
    stepId: TString;
    }> | TObject<    {
    type: TLiteral<"step_end">;
    stepId: TString;
    ok: TBoolean;
    }> | TObject<    {
    type: TLiteral<"loop_state">;
    from: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
    to: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
    trigger: TString;
    iteration: TInteger;
    repairs: TInteger;
    reason: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"retry">;
    scope: TUnion<[TLiteral<"provider">, TLiteral<"workflow">]>;
    attempt: TInteger;
    stepId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"approval_required">;
    approvalId: TString;
    runId: TString;
    agent: TString;
    tool: TString;
    args: TUnknown;
    risk: TUnion<[TLiteral<"low">, TLiteral<"high">]>;
    effect: TObject<    {
    operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
    paths: TArray<TString>;
    urls: TArray<TString>;
    reversible: TBoolean;
    declared: TBoolean;
    }>;
    capability: TOptional<TObject<    {
    tool: TString;
    effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
    replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
    concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
    checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
    durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
    source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
    resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
    issues: TArray<TString>;
    }>>;
    }> | TObject<    {
    type: TLiteral<"approval_resolved">;
    approvalId: TString;
    runId: TString;
    decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
    }> | TObject<    {
    type: TLiteral<"policy_denied">;
    agent: TString;
    tool: TString;
    reason: TString;
    }> | TObject<    {
    type: TLiteral<"budget_exceeded">;
    dimension: TUnion<[TLiteral<"turns">, TLiteral<"toolCalls">, TLiteral<"toolFailures">, TLiteral<"tokens">, TLiteral<"costUsd">]>;
    limit: TNumber;
    actual: TNumber;
    message: TString;
    }> | TObject<    {
    type: TLiteral<"context_budget_resolved">;
    providerId: TString;
    modelId: TString;
    capabilityFingerprint: TString;
    source: TUnion<[TLiteral<"locked_catalog">, TLiteral<"explicit_config">, TLiteral<"provider_metadata">, TLiteral<"conservative_fallback">]>;
    confidence: TUnion<[TLiteral<"verified">, TLiteral<"declared">, TLiteral<"assumed">]>;
    effectiveContextWindow: TNumber;
    reservedOutputTokens: TNumber;
    availableInputTokens: TNumber;
    messageTokens: TNumber;
    stablePrefixTokens: TNumber;
    toolSchemaTokens: TNumber;
    structuredOutputTokens: TNumber;
    multimodalTokens: TNumber;
    protocolOverheadTokens: TNumber;
    safetyMarginTokens: TNumber;
    estimator: TLiteral<"pi-agent-core-estimate-v1">;
    evidence: TArray<TUnion<[TLiteral<"safe_context_intersection">, TLiteral<"assumed_context_window">]>>;
    }> | TObject<    {
    type: TLiteral<"context_compacted">;
    beforeTokens: TNumber;
    afterTokens: TNumber;
    removedMessages: TNumber;
    strategy: TUnion<[TLiteral<"deterministic-v1">, TLiteral<"task-state-v1">]>;
    reason: TLiteral<"threshold">;
    summaryFingerprint: TString;
    capabilityFingerprint: TOptional<TString>;
    lineageDepth: TOptional<TNumber>;
    rebuiltFromCanonical: TOptional<TBoolean>;
    trigger: TOptional<TUnion<[TLiteral<"threshold">, TLiteral<"model_switch">, TLiteral<"provider_overflow">]>>;
    sessionEntryId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"context_compaction_failed">;
    message: TString;
    preservedMessages: TNumber;
    }> | TObject<    {
    type: TLiteral<"context_lifecycle_failed">;
    code: TUnion<[TLiteral<"context_capability_conflict">, TLiteral<"context_budget_exhausted">, TLiteral<"context_artifact_missing">, TLiteral<"context_lineage_corrupt">]>;
    reason: TString;
    pausable: TBoolean;
    preservedMessages: TNumber;
    providerCallBlocked: TLiteral<true>;
    }> | TObject<    {
    type: TLiteral<"context_prefix">;
    agent: TString;
    fingerprint: TString;
    }> | TObject<    {
    type: TLiteral<"provider_request">;
    requestId: TString;
    agent: TString;
    stepId: TOptional<TString>;
    providerId: TString;
    modelId: TString;
    messageFingerprint: TString;
    stablePrefixFingerprint: TString;
    toolSchemaFingerprint: TString;
    capabilityFingerprint: TString;
    contextWorkingSetFingerprint: TString;
    }> | TObject<    {
    type: TLiteral<"artifact_created">;
    artifactId: TString;
    status: TUnion<[TLiteral<"stored">, TLiteral<"blocked">]>;
    sizeBytes: TNumber;
    relativePath: TOptional<TString>;
    sha256: TOptional<TString>;
    mediaType: TString;
    redaction: TUnion<[TLiteral<"none">, TLiteral<"blocked-secret">]>;
    tool: TString;
    callId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"extension_lifecycle">;
    extensionId: TString;
    extensionVersion: TString;
    lifecycle: TUnion<[TLiteral<"before-model">, TLiteral<"before-tool">, TLiteral<"after-tool">, TLiteral<"run-finished">]>;
    status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"timed_out">]>;
    durationMs: TNumber;
    error: TOptional<TString>;
    denied: TOptional<TBoolean>;
    }> | TObject<    {
    type: TLiteral<"checkpoint_created">;
    checkpointId: TString;
    tool: TString;
    callId: TOptional<TString>;
    idempotencyKey: TOptional<TString>;
    targetPath: TOptional<TString>;
    reversible: TBoolean;
    }> | TObject<    {
    type: TLiteral<"tool_execution_evidence">;
    agent: TString;
    tool: TString;
    callId: TString;
    stepId: TOptional<TString>;
    execution: TObject<    {
    durationMs: TNumber;
    exitCode: TUnion<[TInteger, TNull]>;
    commandSha256: TOptional<TString>;
    testCommand: TOptional<TBoolean>;
    }>;
    }> | TObject<    {
    type: TLiteral<"engineering_evidence">;
    stepId: TString;
    textPassed: TBoolean;
    passed: TBoolean;
    successfulTestCommands: TInteger;
    regressionCommandMatched: TBoolean;
    checkpointRecorded: TBoolean;
    diffReviewed: TBoolean;
    reasons: TArray<TString>;
    }> | TObject<    {
    type: TLiteral<"agent_end">;
    agent: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    }> | TObject<    {
    type: TLiteral<"error">;
    message: TString;
    fatal: TBoolean;
    }> | TObject<    {
    type: TLiteral<"input_receipt">;
    inputId: TString;
    status: TLiteral<"pending">;
    contentFingerprint: TString;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"input_claimed">;
    inputId: TString;
    status: TLiteral<"claimed">;
    turnId: TString;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"input_completed">;
    inputId: TString;
    status: TLiteral<"completed">;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"input_discarded">;
    inputId: TString;
    status: TLiteral<"discarded">;
    timestamp: TString;
    }> | TObject<    {
    type: TLiteral<"quiescence_timeout">;
    timeoutMs: TNumber;
    }> | TObject<    {
    type: TLiteral<"tool_lifecycle">;
    agent: TString;
    callId: TString;
    tool: TString;
    stepId: TOptional<TString>;
    turnId: TOptional<TString>;
    resolution: TUnion<[TObject<    {
    phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
    status: TLiteral<"completed">;
    result: TOptional<TObject<    {
    executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
    effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
    persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
    recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
    cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
    authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
    environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
    }>>;
    }>, TObject<    {
    phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
    status: TUnion<[TLiteral<"skipped">, TLiteral<"failed">]>;
    reason: TString;
    result: TOptional<TObject<    {
    executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
    effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
    persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
    recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
    cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
    authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
    environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
    }>>;
    }>]>;
    }>;
    }>[], TObject<    {
    runId: TString;
    approvalId: TOptional<TString>;
    protocolVersion: TLiteral<"2.0">;
    eventSchemaVersion: TLiteral<1>;
    sequence: TInteger;
    eventId: TString;
    timestamp: TString;
    turnId: TOptional<TString>;
    stepId: TOptional<TString>;
    callId: TOptional<TString>;
    receiptId: TOptional<TString>;
    parentRunId: TOptional<TString>;
    childRunId: TOptional<TString>;
    delegationId: TOptional<TString>;
    ignorable: TBoolean;
    sensitivity: TLiteral<"local">;
    eventType: TString;
    payload: TUnknown;
    }>]>>;
    }>;
    readonly queryResult: TObject<    {
    schemaVersion: TLiteral<1>;
    runId: TString;
    derivedFromSequence: TInteger;
    projection: TUnknown;
    }>;
    readonly controlReceipt: TObject<    {
    schemaVersion: TLiteral<1>;
    controlId: TString;
    runId: TString;
    status: TUnion<[TLiteral<"accepted">, TLiteral<"applied">, TLiteral<"rejected">, TLiteral<"duplicate">, TLiteral<"conflict">]>;
    acceptedSequence: TOptional<TInteger>;
    appliedSequence: TOptional<TInteger>;
    rejectedSequence: TOptional<TInteger>;
    duplicateOf: TOptional<TUnion<[TLiteral<"accepted">, TLiteral<"applied">, TLiteral<"rejected">]>>;
    reason: TOptional<TString>;
    }>;
    readonly errorResponse: TObject<    {
    jsonrpc: TLiteral<"2.0">;
    id: TUnion<[TString, TNumber]>;
    error: TObject<    {
    code: TInteger;
    message: TString;
    data: TOptional<TObject<    {
    coremindCode: TOptional<TUnsafe<"timeout" | "aborted" | "budget_exceeded" | "run_timeout" | "step_timeout" | "retry_limit" | "step_limit" | "approval_denied" | "tool_approval_denied" | "tool_execution_failed" | "policy_denied" | "loop_paused" | "unknown_effect" | "committed_effect_pending" | "context_budget_exhausted" | "context_capability_conflict" | "context_artifact_missing" | "unclassified_error" | "resume_input_mismatch" | "resume_config_mismatch" | "run_already_finished" | "operation_not_resumable" | "unknown_run" | "run_state_failed" | "durability_unsupported" | "durability_barrier_failed" | "fact_ledger_poisoned" | "fact_ledger_terminal" | "workspace_lease_recovery_required" | "child_run_orphan_audit_required" | "child_run_parent_mismatch" | "child_run_adapter_failed" | "child_run_policy_escalation" | "child_run_concurrency_limit" | "child_run_identity_mismatch" | "child_run_not_quiescent" | "child_run_unavailable" | "run_state_corrupt" | "run_state_conflict" | "run_state_locked" | "checkpoint_corrupt" | "checkpoint_conflict" | "checkpoint_failed" | "checkpoint_not_found" | "checkpoint_too_large" | "checkpoint_not_reversible" | "invalid_checkpoint_id" | "loop_snapshot_invalid" | "loop_snapshot_mismatch" | "loop_config_invalid" | "loop_state_invalid" | "operation_state_corrupt" | "invalid_operation_state" | "invalid_operation_transition" | "control_invalid" | "control_run_mismatch" | "session_migration_invalid" | "session_layout_conflict" | "invalid_session_id" | "session_restore_failed" | "session_migration_conflict" | "session_migration_failed" | "session_migration_unsupported" | "session_alias_failed" | "session_open_locked" | "invalid_run_id" | "invalid_config" | "invalid_tool" | "tool_capability_conflict" | "tool_lifecycle_invalid" | "effect_receipt_conflict" | "workspace_lease_invalid" | "workspace_lease_not_quiescent" | "environment_terminate_failed" | "context_lineage_corrupt" | "delegation_conflict" | "network_error" | "provider_unavailable" | "provider_timeout" | "provider_transient" | "rate_limit" | "workspace_busy" | "worker_closed" | "already_initialized" | "worker_busy" | "duplicate_tool" | "duplicate_tool_call" | "unknown_tool_call" | "python_tool_failed" | "unknown_approval" | "not_initialized" | "concurrent_run" | "control_unavailable" | "unknown_agent" | "unknown_provider" | "agent_failed" | "no_agent" | "no_prompt" | "no_models" | "loop_failed" | "loop_exhausted" | "loop_no_progress" | "verification_failed" | "retry_exhausted" | "quality_override_audit_failed" | "cursor_ahead" | "cursor_expired" | "run_id_conflict" | "protocol_validation_failed" | "protocol_version_mixed" | "protocol_version_unsupported" | "protocol_capability_missing" | "protocol_version_mismatch" | "invalid_run_handle" | "invalid_event_page" | "invalid_projection_query" | "invalid_control_receipt" | "invalid_run_snapshot" | "invalid_observability" | "parse_error" | "internal_error" | "coding_choice_required" | "coding_invalid_choice" | "coding_invalid_change" | "coding_verification_claim_mismatch" | "coding_delivery_not_verified" | "experiment_invalid" | "experiment_run_invalid" | "extension_invalid" | "extension_duplicate" | "extension_not_trusted" | "extension_capability_denied" | "dns" | "tls" | "http_401" | "http_429" | "exporter_failed" | "exporter_unavailable" | "egress_policy_missing" | "egress_policy_denied" | "configuration_mismatch" | "feedback_consent_missing" | "content_consent_missing" | "redaction_failed" | "environment_probe_failed" | "environment_capability_mismatch" | "environment_requirement_unsatisfied" | "environment_activity_conflict" | "git_command_failed" | "git_invalid_request" | "git_path_outside_workspace" | "process_timeout" | "process_aborted" | "process_output_limit" | "process_spawn_failed" | "diff_complexity_limit" | "diff_input_limit" | "diff_output_limit" | "diff_path_outside_workspace" | "unknown">>;
    details: TOptional<TUnknown>;
    }>>;
    }>;
    }>;
};

export declare const PROTOCOL_V2_SCHEMA_FINGERPRINT: `sha256:${string}`;

export declare const PROTOCOL_V2_VERSION: "2.0";

export declare const PROTOCOL_VERSION: "1.0";

export declare type ProtocolErrorResponse = Static<typeof ProtocolErrorResponseSchema>;

export declare const ProtocolErrorResponseSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
error: TObject<    {
code: TInteger;
message: TString;
data: TOptional<TObject<    {
coremindCode: TOptional<TUnsafe<"timeout" | "aborted" | "budget_exceeded" | "run_timeout" | "step_timeout" | "retry_limit" | "step_limit" | "approval_denied" | "tool_approval_denied" | "tool_execution_failed" | "policy_denied" | "loop_paused" | "unknown_effect" | "committed_effect_pending" | "context_budget_exhausted" | "context_capability_conflict" | "context_artifact_missing" | "unclassified_error" | "resume_input_mismatch" | "resume_config_mismatch" | "run_already_finished" | "operation_not_resumable" | "unknown_run" | "run_state_failed" | "durability_unsupported" | "durability_barrier_failed" | "fact_ledger_poisoned" | "fact_ledger_terminal" | "workspace_lease_recovery_required" | "child_run_orphan_audit_required" | "child_run_parent_mismatch" | "child_run_adapter_failed" | "child_run_policy_escalation" | "child_run_concurrency_limit" | "child_run_identity_mismatch" | "child_run_not_quiescent" | "child_run_unavailable" | "run_state_corrupt" | "run_state_conflict" | "run_state_locked" | "checkpoint_corrupt" | "checkpoint_conflict" | "checkpoint_failed" | "checkpoint_not_found" | "checkpoint_too_large" | "checkpoint_not_reversible" | "invalid_checkpoint_id" | "loop_snapshot_invalid" | "loop_snapshot_mismatch" | "loop_config_invalid" | "loop_state_invalid" | "operation_state_corrupt" | "invalid_operation_state" | "invalid_operation_transition" | "control_invalid" | "control_run_mismatch" | "session_migration_invalid" | "session_layout_conflict" | "invalid_session_id" | "session_restore_failed" | "session_migration_conflict" | "session_migration_failed" | "session_migration_unsupported" | "session_alias_failed" | "session_open_locked" | "invalid_run_id" | "invalid_config" | "invalid_tool" | "tool_capability_conflict" | "tool_lifecycle_invalid" | "effect_receipt_conflict" | "workspace_lease_invalid" | "workspace_lease_not_quiescent" | "environment_terminate_failed" | "context_lineage_corrupt" | "delegation_conflict" | "network_error" | "provider_unavailable" | "provider_timeout" | "provider_transient" | "rate_limit" | "workspace_busy" | "worker_closed" | "already_initialized" | "worker_busy" | "duplicate_tool" | "duplicate_tool_call" | "unknown_tool_call" | "python_tool_failed" | "unknown_approval" | "not_initialized" | "concurrent_run" | "control_unavailable" | "unknown_agent" | "unknown_provider" | "agent_failed" | "no_agent" | "no_prompt" | "no_models" | "loop_failed" | "loop_exhausted" | "loop_no_progress" | "verification_failed" | "retry_exhausted" | "quality_override_audit_failed" | "cursor_ahead" | "cursor_expired" | "run_id_conflict" | "protocol_validation_failed" | "protocol_version_mixed" | "protocol_version_unsupported" | "protocol_capability_missing" | "protocol_version_mismatch" | "invalid_run_handle" | "invalid_event_page" | "invalid_projection_query" | "invalid_control_receipt" | "invalid_run_snapshot" | "invalid_observability" | "parse_error" | "internal_error" | "coding_choice_required" | "coding_invalid_choice" | "coding_invalid_change" | "coding_verification_claim_mismatch" | "coding_delivery_not_verified" | "experiment_invalid" | "experiment_run_invalid" | "extension_invalid" | "extension_duplicate" | "extension_not_trusted" | "extension_capability_denied" | "dns" | "tls" | "http_401" | "http_429" | "exporter_failed" | "exporter_unavailable" | "egress_policy_missing" | "egress_policy_denied" | "configuration_mismatch" | "feedback_consent_missing" | "content_consent_missing" | "redaction_failed" | "environment_probe_failed" | "environment_capability_mismatch" | "environment_requirement_unsatisfied" | "environment_activity_conflict" | "git_command_failed" | "git_invalid_request" | "git_path_outside_workspace" | "process_timeout" | "process_aborted" | "process_output_limit" | "process_spawn_failed" | "diff_complexity_limit" | "diff_input_limit" | "diff_output_limit" | "diff_path_outside_workspace" | "unknown">>;
details: TOptional<TUnknown>;
}>>;
}>;
}>;

export declare type ProtocolEventNotification = Static<typeof ProtocolEventNotificationSchema>;

export declare const ProtocolEventNotificationSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
method: TLiteral<"event">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
runId: TString;
sequence: TInteger;
timestamp: TString;
event: TUnknown;
}>;
}>;

export declare type ProtocolRequest = Static<typeof ProtocolRequestSchema>;

export declare const ProtocolRequestSchema: TUnion<[TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"initialize">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
config: TOptional<TUnknown>;
configPath: TOptional<TString>;
configDir: TOptional<TString>;
cwd: TOptional<TString>;
sessionId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"run">;
params: TObject<    {
input: TOptional<TString>;
qualityOverride: TOptional<TBoolean>;
runId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
agent: TString;
message: TString;
runId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"cancel">;
params: TObject<    {
runId: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"approve">;
params: TObject<    {
runId: TString;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"register_tool">;
params: TObject<    {
name: TString;
description: TString;
parameters: TUnknown;
effect: TObject<    {
operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
label: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"tool_result">;
params: TObject<    {
callId: TString;
result: TOptional<TUnknown>;
error: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"inspect_run">;
params: TObject<    {
runId: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"resume_run">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_diff">;
params: TObject<    {
runId: TString;
checkpointId: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"checkpoint_restore">;
params: TObject<    {
runId: TString;
checkpointId: TString;
confirm: TLiteral<true>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"close">;
params: TObject<    {}>;
}>]>;

export declare type ProtocolRunSnapshot = Static<typeof RunSnapshotSchema>;

export declare type ProtocolSuccessResponse = Static<typeof ProtocolSuccessResponseSchema>;

export declare const ProtocolSuccessResponseSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
result: TUnknown;
}>;

export declare type ProtocolV2ChatRequest = Static<typeof ProtocolV2ChatRequestSchema>;

export declare const ProtocolV2ChatRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
runId: TString;
agent: TString;
message: TString;
}>;
}>;

export declare type ProtocolV2ControlCommand = Static<typeof ProtocolV2ControlCommandSchema>;

export declare const ProtocolV2ControlCommandSchema: TUnion<[TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"cancel">;
reason: TOptional<TString>;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"approval">;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"steering">;
message: TString;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"follow_up">;
message: TString;
}>]>;

export declare type ProtocolV2ControlReceipt = Static<typeof ProtocolV2ControlReceiptSchema>;

export declare const ProtocolV2ControlReceiptSchema: TObject<    {
schemaVersion: TLiteral<1>;
controlId: TString;
runId: TString;
status: TUnion<[TLiteral<"accepted">, TLiteral<"applied">, TLiteral<"rejected">, TLiteral<"duplicate">, TLiteral<"conflict">]>;
acceptedSequence: TOptional<TInteger>;
appliedSequence: TOptional<TInteger>;
rejectedSequence: TOptional<TInteger>;
duplicateOf: TOptional<TUnion<[TLiteral<"accepted">, TLiteral<"applied">, TLiteral<"rejected">]>>;
reason: TOptional<TString>;
}>;

export declare type ProtocolV2ControlRequest = Static<typeof ProtocolV2ControlRequestSchema>;

export declare const ProtocolV2ControlRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"control">;
params: TUnion<[TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"cancel">;
reason: TOptional<TString>;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"approval">;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"steering">;
message: TString;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"follow_up">;
message: TString;
}>]>;
}>;

export declare const ProtocolV2ErrorResponseSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
error: TObject<    {
code: TInteger;
message: TString;
data: TOptional<TObject<    {
coremindCode: TOptional<TUnsafe<"timeout" | "aborted" | "budget_exceeded" | "run_timeout" | "step_timeout" | "retry_limit" | "step_limit" | "approval_denied" | "tool_approval_denied" | "tool_execution_failed" | "policy_denied" | "loop_paused" | "unknown_effect" | "committed_effect_pending" | "context_budget_exhausted" | "context_capability_conflict" | "context_artifact_missing" | "unclassified_error" | "resume_input_mismatch" | "resume_config_mismatch" | "run_already_finished" | "operation_not_resumable" | "unknown_run" | "run_state_failed" | "durability_unsupported" | "durability_barrier_failed" | "fact_ledger_poisoned" | "fact_ledger_terminal" | "workspace_lease_recovery_required" | "child_run_orphan_audit_required" | "child_run_parent_mismatch" | "child_run_adapter_failed" | "child_run_policy_escalation" | "child_run_concurrency_limit" | "child_run_identity_mismatch" | "child_run_not_quiescent" | "child_run_unavailable" | "run_state_corrupt" | "run_state_conflict" | "run_state_locked" | "checkpoint_corrupt" | "checkpoint_conflict" | "checkpoint_failed" | "checkpoint_not_found" | "checkpoint_too_large" | "checkpoint_not_reversible" | "invalid_checkpoint_id" | "loop_snapshot_invalid" | "loop_snapshot_mismatch" | "loop_config_invalid" | "loop_state_invalid" | "operation_state_corrupt" | "invalid_operation_state" | "invalid_operation_transition" | "control_invalid" | "control_run_mismatch" | "session_migration_invalid" | "session_layout_conflict" | "invalid_session_id" | "session_restore_failed" | "session_migration_conflict" | "session_migration_failed" | "session_migration_unsupported" | "session_alias_failed" | "session_open_locked" | "invalid_run_id" | "invalid_config" | "invalid_tool" | "tool_capability_conflict" | "tool_lifecycle_invalid" | "effect_receipt_conflict" | "workspace_lease_invalid" | "workspace_lease_not_quiescent" | "environment_terminate_failed" | "context_lineage_corrupt" | "delegation_conflict" | "network_error" | "provider_unavailable" | "provider_timeout" | "provider_transient" | "rate_limit" | "workspace_busy" | "worker_closed" | "already_initialized" | "worker_busy" | "duplicate_tool" | "duplicate_tool_call" | "unknown_tool_call" | "python_tool_failed" | "unknown_approval" | "not_initialized" | "concurrent_run" | "control_unavailable" | "unknown_agent" | "unknown_provider" | "agent_failed" | "no_agent" | "no_prompt" | "no_models" | "loop_failed" | "loop_exhausted" | "loop_no_progress" | "verification_failed" | "retry_exhausted" | "quality_override_audit_failed" | "cursor_ahead" | "cursor_expired" | "run_id_conflict" | "protocol_validation_failed" | "protocol_version_mixed" | "protocol_version_unsupported" | "protocol_capability_missing" | "protocol_version_mismatch" | "invalid_run_handle" | "invalid_event_page" | "invalid_projection_query" | "invalid_control_receipt" | "invalid_run_snapshot" | "invalid_observability" | "parse_error" | "internal_error" | "coding_choice_required" | "coding_invalid_choice" | "coding_invalid_change" | "coding_verification_claim_mismatch" | "coding_delivery_not_verified" | "experiment_invalid" | "experiment_run_invalid" | "extension_invalid" | "extension_duplicate" | "extension_not_trusted" | "extension_capability_denied" | "dns" | "tls" | "http_401" | "http_429" | "exporter_failed" | "exporter_unavailable" | "egress_policy_missing" | "egress_policy_denied" | "configuration_mismatch" | "feedback_consent_missing" | "content_consent_missing" | "redaction_failed" | "environment_probe_failed" | "environment_capability_mismatch" | "environment_requirement_unsatisfied" | "environment_activity_conflict" | "git_command_failed" | "git_invalid_request" | "git_path_outside_workspace" | "process_timeout" | "process_aborted" | "process_output_limit" | "process_spawn_failed" | "diff_complexity_limit" | "diff_input_limit" | "diff_output_limit" | "diff_path_outside_workspace" | "unknown">>;
details: TOptional<TUnknown>;
}>>;
}>;
}>;

export declare type ProtocolV2EventEnvelope = Static<typeof ProtocolV2EventEnvelopeSchema>;

/** 38 类 CoreMind 事件均以 eventType/payload.type 判别并进入 schema fingerprint。 */
export declare const ProtocolV2EventEnvelopeSchema: TUnion<[...TObject<    {
runId: TString;
approvalId: TOptional<TString>;
protocolVersion: TLiteral<"2.0">;
eventSchemaVersion: TLiteral<1>;
sequence: TInteger;
eventId: TString;
timestamp: TString;
turnId: TOptional<TString>;
stepId: TOptional<TString>;
callId: TOptional<TString>;
receiptId: TOptional<TString>;
parentRunId: TOptional<TString>;
childRunId: TOptional<TString>;
delegationId: TOptional<TString>;
ignorable: TBoolean;
sensitivity: TLiteral<"local">;
eventType: TLiteral<"budget_exceeded" | "policy_denied" | "capability_resolved" | "approval_resolved" | "agent_start" | "turn_end" | "text_delta" | "tool_call" | "tool_result" | "tool_attempt" | "workspace_lease" | "effect_receipt" | "step_start" | "step_output" | "step_resumed" | "step_end" | "loop_state" | "retry" | "approval_required" | "context_budget_resolved" | "context_compacted" | "context_compaction_failed" | "context_lifecycle_failed" | "context_prefix" | "provider_request" | "artifact_created" | "extension_lifecycle" | "error" | "checkpoint_created" | "tool_execution_evidence" | "engineering_evidence" | "agent_end" | "input_receipt" | "input_claimed" | "input_completed" | "input_discarded" | "quiescence_timeout" | "tool_lifecycle">;
payload: TObject<    {
type: TLiteral<"agent_start">;
agent: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"turn_end">;
agent: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
tokens: TOptional<TNumber>;
inputTokens: TOptional<TNumber>;
outputTokens: TOptional<TNumber>;
cacheReadTokens: TOptional<TNumber>;
cacheWriteTokens: TOptional<TNumber>;
promptCacheStatus: TOptional<TUnion<[TLiteral<"available">, TLiteral<"unavailable">]>>;
costUsd: TOptional<TNumber>;
requestsAnotherTurn: TOptional<TBoolean>;
}> | TObject<    {
type: TLiteral<"text_delta">;
agent: TString;
delta: TString;
stepId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"tool_call">;
agent: TString;
tool: TString;
args: TUnknown;
argumentsFingerprint: TOptional<TString>;
callId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"tool_result">;
agent: TString;
tool: TString;
isError: TBoolean;
callId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"tool_attempt">;
attemptId: TString;
previousReceiptId: TString;
attempt: TInteger;
agent: TString;
tool: TString;
callId: TString;
stepId: TOptional<TString>;
argumentsFingerprint: TString;
}> | TObject<    {
type: TLiteral<"capability_resolved">;
agent: TString;
tool: TString;
callId: TString;
stepId: TOptional<TString>;
capability: TObject<    {
tool: TString;
effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
issues: TArray<TString>;
}>;
recoveryDisposition: TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>;
}> | TObject<    {
type: TLiteral<"workspace_lease">;
status: TUnion<[TLiteral<"acquired">, TLiteral<"released">, TLiteral<"recovery_required">]>;
canonicalRoot: TString;
lane: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
owner: TObject<    {
runId: TString;
callId: TString;
pid: TInteger;
}>;
agent: TString;
callId: TString;
stepId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"effect_receipt">;
idempotencyKey: TString;
tool: TString;
status: TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>;
agent: TOptional<TString>;
callId: TOptional<TString>;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
binding: TOptional<TObject<    {
version: TLiteral<1>;
runId: TString;
turnId: TString;
agent: TString;
stepId: TOptional<TString>;
callId: TString;
tool: TString;
argumentsFingerprint: TString;
capabilityFingerprint: TString;
}>>;
}> | TObject<    {
type: TLiteral<"step_start">;
stepId: TString;
kind: TString;
}> | TObject<    {
type: TLiteral<"step_output">;
stepId: TString;
agent: TString;
text: TString;
saveAs: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"step_resumed">;
stepId: TString;
}> | TObject<    {
type: TLiteral<"step_end">;
stepId: TString;
ok: TBoolean;
}> | TObject<    {
type: TLiteral<"loop_state">;
from: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
to: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
trigger: TString;
iteration: TInteger;
repairs: TInteger;
reason: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"retry">;
scope: TUnion<[TLiteral<"provider">, TLiteral<"workflow">]>;
attempt: TInteger;
stepId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"approval_required">;
approvalId: TString;
runId: TString;
agent: TString;
tool: TString;
args: TUnknown;
risk: TUnion<[TLiteral<"low">, TLiteral<"high">]>;
effect: TObject<    {
operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
paths: TArray<TString>;
urls: TArray<TString>;
reversible: TBoolean;
declared: TBoolean;
}>;
capability: TOptional<TObject<    {
tool: TString;
effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
issues: TArray<TString>;
}>>;
}> | TObject<    {
type: TLiteral<"approval_resolved">;
approvalId: TString;
runId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}> | TObject<    {
type: TLiteral<"policy_denied">;
agent: TString;
tool: TString;
reason: TString;
}> | TObject<    {
type: TLiteral<"budget_exceeded">;
dimension: TUnion<[TLiteral<"turns">, TLiteral<"toolCalls">, TLiteral<"toolFailures">, TLiteral<"tokens">, TLiteral<"costUsd">]>;
limit: TNumber;
actual: TNumber;
message: TString;
}> | TObject<    {
type: TLiteral<"context_budget_resolved">;
providerId: TString;
modelId: TString;
capabilityFingerprint: TString;
source: TUnion<[TLiteral<"locked_catalog">, TLiteral<"explicit_config">, TLiteral<"provider_metadata">, TLiteral<"conservative_fallback">]>;
confidence: TUnion<[TLiteral<"verified">, TLiteral<"declared">, TLiteral<"assumed">]>;
effectiveContextWindow: TNumber;
reservedOutputTokens: TNumber;
availableInputTokens: TNumber;
messageTokens: TNumber;
stablePrefixTokens: TNumber;
toolSchemaTokens: TNumber;
structuredOutputTokens: TNumber;
multimodalTokens: TNumber;
protocolOverheadTokens: TNumber;
safetyMarginTokens: TNumber;
estimator: TLiteral<"pi-agent-core-estimate-v1">;
evidence: TArray<TUnion<[TLiteral<"safe_context_intersection">, TLiteral<"assumed_context_window">]>>;
}> | TObject<    {
type: TLiteral<"context_compacted">;
beforeTokens: TNumber;
afterTokens: TNumber;
removedMessages: TNumber;
strategy: TUnion<[TLiteral<"deterministic-v1">, TLiteral<"task-state-v1">]>;
reason: TLiteral<"threshold">;
summaryFingerprint: TString;
capabilityFingerprint: TOptional<TString>;
lineageDepth: TOptional<TNumber>;
rebuiltFromCanonical: TOptional<TBoolean>;
trigger: TOptional<TUnion<[TLiteral<"threshold">, TLiteral<"model_switch">, TLiteral<"provider_overflow">]>>;
sessionEntryId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"context_compaction_failed">;
message: TString;
preservedMessages: TNumber;
}> | TObject<    {
type: TLiteral<"context_lifecycle_failed">;
code: TUnion<[TLiteral<"context_capability_conflict">, TLiteral<"context_budget_exhausted">, TLiteral<"context_artifact_missing">, TLiteral<"context_lineage_corrupt">]>;
reason: TString;
pausable: TBoolean;
preservedMessages: TNumber;
providerCallBlocked: TLiteral<true>;
}> | TObject<    {
type: TLiteral<"context_prefix">;
agent: TString;
fingerprint: TString;
}> | TObject<    {
type: TLiteral<"provider_request">;
requestId: TString;
agent: TString;
stepId: TOptional<TString>;
providerId: TString;
modelId: TString;
messageFingerprint: TString;
stablePrefixFingerprint: TString;
toolSchemaFingerprint: TString;
capabilityFingerprint: TString;
contextWorkingSetFingerprint: TString;
}> | TObject<    {
type: TLiteral<"artifact_created">;
artifactId: TString;
status: TUnion<[TLiteral<"stored">, TLiteral<"blocked">]>;
sizeBytes: TNumber;
relativePath: TOptional<TString>;
sha256: TOptional<TString>;
mediaType: TString;
redaction: TUnion<[TLiteral<"none">, TLiteral<"blocked-secret">]>;
tool: TString;
callId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"extension_lifecycle">;
extensionId: TString;
extensionVersion: TString;
lifecycle: TUnion<[TLiteral<"before-model">, TLiteral<"before-tool">, TLiteral<"after-tool">, TLiteral<"run-finished">]>;
status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"timed_out">]>;
durationMs: TNumber;
error: TOptional<TString>;
denied: TOptional<TBoolean>;
}> | TObject<    {
type: TLiteral<"checkpoint_created">;
checkpointId: TString;
tool: TString;
callId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
targetPath: TOptional<TString>;
reversible: TBoolean;
}> | TObject<    {
type: TLiteral<"tool_execution_evidence">;
agent: TString;
tool: TString;
callId: TString;
stepId: TOptional<TString>;
execution: TObject<    {
durationMs: TNumber;
exitCode: TUnion<[TInteger, TNull]>;
commandSha256: TOptional<TString>;
testCommand: TOptional<TBoolean>;
}>;
}> | TObject<    {
type: TLiteral<"engineering_evidence">;
stepId: TString;
textPassed: TBoolean;
passed: TBoolean;
successfulTestCommands: TInteger;
regressionCommandMatched: TBoolean;
checkpointRecorded: TBoolean;
diffReviewed: TBoolean;
reasons: TArray<TString>;
}> | TObject<    {
type: TLiteral<"agent_end">;
agent: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"error">;
message: TString;
fatal: TBoolean;
}> | TObject<    {
type: TLiteral<"input_receipt">;
inputId: TString;
status: TLiteral<"pending">;
contentFingerprint: TString;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"input_claimed">;
inputId: TString;
status: TLiteral<"claimed">;
turnId: TString;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"input_completed">;
inputId: TString;
status: TLiteral<"completed">;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"input_discarded">;
inputId: TString;
status: TLiteral<"discarded">;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"quiescence_timeout">;
timeoutMs: TNumber;
}> | TObject<    {
type: TLiteral<"tool_lifecycle">;
agent: TString;
callId: TString;
tool: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
resolution: TUnion<[TObject<    {
phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
status: TLiteral<"completed">;
result: TOptional<TObject<    {
executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
}>>;
}>, TObject<    {
phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
status: TUnion<[TLiteral<"skipped">, TLiteral<"failed">]>;
reason: TString;
result: TOptional<TObject<    {
executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
}>>;
}>]>;
}>;
}>[], TObject<    {
runId: TString;
approvalId: TOptional<TString>;
protocolVersion: TLiteral<"2.0">;
eventSchemaVersion: TLiteral<1>;
sequence: TInteger;
eventId: TString;
timestamp: TString;
turnId: TOptional<TString>;
stepId: TOptional<TString>;
callId: TOptional<TString>;
receiptId: TOptional<TString>;
parentRunId: TOptional<TString>;
childRunId: TOptional<TString>;
delegationId: TOptional<TString>;
ignorable: TBoolean;
sensitivity: TLiteral<"local">;
eventType: TString;
payload: TUnknown;
}>]>;

export declare type ProtocolV2EventPage = Static<typeof ProtocolV2EventPageSchema>;

export declare const ProtocolV2EventPageSchema: TObject<    {
schemaVersion: TLiteral<1>;
runId: TString;
afterSequence: TInteger;
nextCursor: TInteger;
hasMore: TBoolean;
events: TArray<TUnion<[...TObject<    {
runId: TString;
approvalId: TOptional<TString>;
protocolVersion: TLiteral<"2.0">;
eventSchemaVersion: TLiteral<1>;
sequence: TInteger;
eventId: TString;
timestamp: TString;
turnId: TOptional<TString>;
stepId: TOptional<TString>;
callId: TOptional<TString>;
receiptId: TOptional<TString>;
parentRunId: TOptional<TString>;
childRunId: TOptional<TString>;
delegationId: TOptional<TString>;
ignorable: TBoolean;
sensitivity: TLiteral<"local">;
eventType: TLiteral<"budget_exceeded" | "policy_denied" | "capability_resolved" | "approval_resolved" | "agent_start" | "turn_end" | "text_delta" | "tool_call" | "tool_result" | "tool_attempt" | "workspace_lease" | "effect_receipt" | "step_start" | "step_output" | "step_resumed" | "step_end" | "loop_state" | "retry" | "approval_required" | "context_budget_resolved" | "context_compacted" | "context_compaction_failed" | "context_lifecycle_failed" | "context_prefix" | "provider_request" | "artifact_created" | "extension_lifecycle" | "error" | "checkpoint_created" | "tool_execution_evidence" | "engineering_evidence" | "agent_end" | "input_receipt" | "input_claimed" | "input_completed" | "input_discarded" | "quiescence_timeout" | "tool_lifecycle">;
payload: TObject<    {
type: TLiteral<"agent_start">;
agent: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"turn_end">;
agent: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
tokens: TOptional<TNumber>;
inputTokens: TOptional<TNumber>;
outputTokens: TOptional<TNumber>;
cacheReadTokens: TOptional<TNumber>;
cacheWriteTokens: TOptional<TNumber>;
promptCacheStatus: TOptional<TUnion<[TLiteral<"available">, TLiteral<"unavailable">]>>;
costUsd: TOptional<TNumber>;
requestsAnotherTurn: TOptional<TBoolean>;
}> | TObject<    {
type: TLiteral<"text_delta">;
agent: TString;
delta: TString;
stepId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"tool_call">;
agent: TString;
tool: TString;
args: TUnknown;
argumentsFingerprint: TOptional<TString>;
callId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"tool_result">;
agent: TString;
tool: TString;
isError: TBoolean;
callId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"tool_attempt">;
attemptId: TString;
previousReceiptId: TString;
attempt: TInteger;
agent: TString;
tool: TString;
callId: TString;
stepId: TOptional<TString>;
argumentsFingerprint: TString;
}> | TObject<    {
type: TLiteral<"capability_resolved">;
agent: TString;
tool: TString;
callId: TString;
stepId: TOptional<TString>;
capability: TObject<    {
tool: TString;
effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
issues: TArray<TString>;
}>;
recoveryDisposition: TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>;
}> | TObject<    {
type: TLiteral<"workspace_lease">;
status: TUnion<[TLiteral<"acquired">, TLiteral<"released">, TLiteral<"recovery_required">]>;
canonicalRoot: TString;
lane: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
owner: TObject<    {
runId: TString;
callId: TString;
pid: TInteger;
}>;
agent: TString;
callId: TString;
stepId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"effect_receipt">;
idempotencyKey: TString;
tool: TString;
status: TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>;
agent: TOptional<TString>;
callId: TOptional<TString>;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
binding: TOptional<TObject<    {
version: TLiteral<1>;
runId: TString;
turnId: TString;
agent: TString;
stepId: TOptional<TString>;
callId: TString;
tool: TString;
argumentsFingerprint: TString;
capabilityFingerprint: TString;
}>>;
}> | TObject<    {
type: TLiteral<"step_start">;
stepId: TString;
kind: TString;
}> | TObject<    {
type: TLiteral<"step_output">;
stepId: TString;
agent: TString;
text: TString;
saveAs: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"step_resumed">;
stepId: TString;
}> | TObject<    {
type: TLiteral<"step_end">;
stepId: TString;
ok: TBoolean;
}> | TObject<    {
type: TLiteral<"loop_state">;
from: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
to: TUnion<[TLiteral<"idle">, TLiteral<"planning">, TLiteral<"executing">, TLiteral<"verifying">, TLiteral<"repairing">, TLiteral<"paused">, TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
trigger: TString;
iteration: TInteger;
repairs: TInteger;
reason: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"retry">;
scope: TUnion<[TLiteral<"provider">, TLiteral<"workflow">]>;
attempt: TInteger;
stepId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"approval_required">;
approvalId: TString;
runId: TString;
agent: TString;
tool: TString;
args: TUnknown;
risk: TUnion<[TLiteral<"low">, TLiteral<"high">]>;
effect: TObject<    {
operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
paths: TArray<TString>;
urls: TArray<TString>;
reversible: TBoolean;
declared: TBoolean;
}>;
capability: TOptional<TObject<    {
tool: TString;
effect: TUnion<[TLiteral<"none">, TLiteral<"workspace">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">, TLiteral<"unknown">]>;
replay: TUnion<[TLiteral<"safe">, TLiteral<"idempotent">, TLiteral<"unsafe">, TLiteral<"unknown">]>;
concurrency: TUnion<[TLiteral<"parallel">, TLiteral<"run_serial">, TLiteral<"workspace_exclusive">]>;
checkpoint: TUnion<[TLiteral<"none">, TLiteral<"required">, TLiteral<"unsupported">]>;
durability: TUnion<[TLiteral<"ordinary">, TLiteral<"critical">]>;
source: TUnion<[TLiteral<"builtin">, TLiteral<"registered">, TLiteral<"inferred">, TLiteral<"fallback">]>;
resolution: TUnion<[TLiteral<"resolved">, TLiteral<"fallback">]>;
issues: TArray<TString>;
}>>;
}> | TObject<    {
type: TLiteral<"approval_resolved">;
approvalId: TString;
runId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}> | TObject<    {
type: TLiteral<"policy_denied">;
agent: TString;
tool: TString;
reason: TString;
}> | TObject<    {
type: TLiteral<"budget_exceeded">;
dimension: TUnion<[TLiteral<"turns">, TLiteral<"toolCalls">, TLiteral<"toolFailures">, TLiteral<"tokens">, TLiteral<"costUsd">]>;
limit: TNumber;
actual: TNumber;
message: TString;
}> | TObject<    {
type: TLiteral<"context_budget_resolved">;
providerId: TString;
modelId: TString;
capabilityFingerprint: TString;
source: TUnion<[TLiteral<"locked_catalog">, TLiteral<"explicit_config">, TLiteral<"provider_metadata">, TLiteral<"conservative_fallback">]>;
confidence: TUnion<[TLiteral<"verified">, TLiteral<"declared">, TLiteral<"assumed">]>;
effectiveContextWindow: TNumber;
reservedOutputTokens: TNumber;
availableInputTokens: TNumber;
messageTokens: TNumber;
stablePrefixTokens: TNumber;
toolSchemaTokens: TNumber;
structuredOutputTokens: TNumber;
multimodalTokens: TNumber;
protocolOverheadTokens: TNumber;
safetyMarginTokens: TNumber;
estimator: TLiteral<"pi-agent-core-estimate-v1">;
evidence: TArray<TUnion<[TLiteral<"safe_context_intersection">, TLiteral<"assumed_context_window">]>>;
}> | TObject<    {
type: TLiteral<"context_compacted">;
beforeTokens: TNumber;
afterTokens: TNumber;
removedMessages: TNumber;
strategy: TUnion<[TLiteral<"deterministic-v1">, TLiteral<"task-state-v1">]>;
reason: TLiteral<"threshold">;
summaryFingerprint: TString;
capabilityFingerprint: TOptional<TString>;
lineageDepth: TOptional<TNumber>;
rebuiltFromCanonical: TOptional<TBoolean>;
trigger: TOptional<TUnion<[TLiteral<"threshold">, TLiteral<"model_switch">, TLiteral<"provider_overflow">]>>;
sessionEntryId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"context_compaction_failed">;
message: TString;
preservedMessages: TNumber;
}> | TObject<    {
type: TLiteral<"context_lifecycle_failed">;
code: TUnion<[TLiteral<"context_capability_conflict">, TLiteral<"context_budget_exhausted">, TLiteral<"context_artifact_missing">, TLiteral<"context_lineage_corrupt">]>;
reason: TString;
pausable: TBoolean;
preservedMessages: TNumber;
providerCallBlocked: TLiteral<true>;
}> | TObject<    {
type: TLiteral<"context_prefix">;
agent: TString;
fingerprint: TString;
}> | TObject<    {
type: TLiteral<"provider_request">;
requestId: TString;
agent: TString;
stepId: TOptional<TString>;
providerId: TString;
modelId: TString;
messageFingerprint: TString;
stablePrefixFingerprint: TString;
toolSchemaFingerprint: TString;
capabilityFingerprint: TString;
contextWorkingSetFingerprint: TString;
}> | TObject<    {
type: TLiteral<"artifact_created">;
artifactId: TString;
status: TUnion<[TLiteral<"stored">, TLiteral<"blocked">]>;
sizeBytes: TNumber;
relativePath: TOptional<TString>;
sha256: TOptional<TString>;
mediaType: TString;
redaction: TUnion<[TLiteral<"none">, TLiteral<"blocked-secret">]>;
tool: TString;
callId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"extension_lifecycle">;
extensionId: TString;
extensionVersion: TString;
lifecycle: TUnion<[TLiteral<"before-model">, TLiteral<"before-tool">, TLiteral<"after-tool">, TLiteral<"run-finished">]>;
status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"timed_out">]>;
durationMs: TNumber;
error: TOptional<TString>;
denied: TOptional<TBoolean>;
}> | TObject<    {
type: TLiteral<"checkpoint_created">;
checkpointId: TString;
tool: TString;
callId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
targetPath: TOptional<TString>;
reversible: TBoolean;
}> | TObject<    {
type: TLiteral<"tool_execution_evidence">;
agent: TString;
tool: TString;
callId: TString;
stepId: TOptional<TString>;
execution: TObject<    {
durationMs: TNumber;
exitCode: TUnion<[TInteger, TNull]>;
commandSha256: TOptional<TString>;
testCommand: TOptional<TBoolean>;
}>;
}> | TObject<    {
type: TLiteral<"engineering_evidence">;
stepId: TString;
textPassed: TBoolean;
passed: TBoolean;
successfulTestCommands: TInteger;
regressionCommandMatched: TBoolean;
checkpointRecorded: TBoolean;
diffReviewed: TBoolean;
reasons: TArray<TString>;
}> | TObject<    {
type: TLiteral<"agent_end">;
agent: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
}> | TObject<    {
type: TLiteral<"error">;
message: TString;
fatal: TBoolean;
}> | TObject<    {
type: TLiteral<"input_receipt">;
inputId: TString;
status: TLiteral<"pending">;
contentFingerprint: TString;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"input_claimed">;
inputId: TString;
status: TLiteral<"claimed">;
turnId: TString;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"input_completed">;
inputId: TString;
status: TLiteral<"completed">;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"input_discarded">;
inputId: TString;
status: TLiteral<"discarded">;
timestamp: TString;
}> | TObject<    {
type: TLiteral<"quiescence_timeout">;
timeoutMs: TNumber;
}> | TObject<    {
type: TLiteral<"tool_lifecycle">;
agent: TString;
callId: TString;
tool: TString;
stepId: TOptional<TString>;
turnId: TOptional<TString>;
resolution: TUnion<[TObject<    {
phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
status: TLiteral<"completed">;
result: TOptional<TObject<    {
executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
}>>;
}>, TObject<    {
phase: TUnion<[TLiteral<"call_recorded">, TLiteral<"capability_resolved">, TLiteral<"policy_resolved">, TLiteral<"approval_resolved">, TLiteral<"lease_acquired">, TLiteral<"checkpoint_durable">, TLiteral<"started_durable">, TLiteral<"executing">, TLiteral<"observed">, TLiteral<"result_durable">, TLiteral<"terminal">]>;
status: TUnion<[TLiteral<"skipped">, TLiteral<"failed">]>;
reason: TString;
result: TOptional<TObject<    {
executionOutcome: TOptional<TUnion<[TLiteral<"not_invoked">, TLiteral<"returned">, TLiteral<"threw">, TLiteral<"timed_out">, TLiteral<"aborted">]>>;
effectState: TOptional<TUnion<[TLiteral<"not_started">, TLiteral<"started">, TLiteral<"committed">, TLiteral<"unknown">]>>;
persistenceState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"durable">, TLiteral<"failed">, TLiteral<"unknown">]>>;
recoveryDisposition: TOptional<TUnion<[TLiteral<"replay_safe">, TLiteral<"requires_proof">, TLiteral<"requires_human">, TLiteral<"forbidden">]>>;
cleanupState: TOptional<TUnion<[TLiteral<"not_needed">, TLiteral<"pending">, TLiteral<"quiescent">, TLiteral<"failed">]>>;
authorizationState: TOptional<TUnion<[TLiteral<"pending">, TLiteral<"allowed">, TLiteral<"approved">, TLiteral<"denied">, TLiteral<"expired">]>>;
environmentState: TOptional<TUnion<[TLiteral<"available">, TLiteral<"degraded">, TLiteral<"unavailable">]>>;
}>>;
}>]>;
}>;
}>[], TObject<    {
runId: TString;
approvalId: TOptional<TString>;
protocolVersion: TLiteral<"2.0">;
eventSchemaVersion: TLiteral<1>;
sequence: TInteger;
eventId: TString;
timestamp: TString;
turnId: TOptional<TString>;
stepId: TOptional<TString>;
callId: TOptional<TString>;
receiptId: TOptional<TString>;
parentRunId: TOptional<TString>;
childRunId: TOptional<TString>;
delegationId: TOptional<TString>;
ignorable: TBoolean;
sensitivity: TLiteral<"local">;
eventType: TString;
payload: TUnknown;
}>]>>;
}>;

export declare type ProtocolV2EventsRequest = Static<typeof ProtocolV2EventsRequestSchema>;

export declare const ProtocolV2EventsRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"events">;
params: TObject<    {
runId: TString;
afterSequence: TInteger;
limit: TOptional<TInteger>;
}>;
}>;

export declare type ProtocolV2InitializeRequest = Static<typeof ProtocolV2InitializeRequestSchema>;

export declare const ProtocolV2InitializeRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"initialize">;
params: TObject<    {
protocolRange: TObject<    {
minVersion: TString;
maxVersion: TString;
}>;
capabilities: TOptional<TArray<TString>>;
config: TOptional<TUnknown>;
configPath: TOptional<TString>;
configDir: TOptional<TString>;
cwd: TOptional<TString>;
sessionId: TOptional<TString>;
}>;
}>;

export declare type ProtocolV2InitializeResult = Static<typeof ProtocolV2InitializeResultSchema>;

export declare const ProtocolV2InitializeResultSchema: TObject<    {
selectedProtocol: TLiteral<"2.0">;
runtime: TLiteral<"node">;
warnings: TArray<TString>;
serverCapabilities: TArray<TString>;
schemaFingerprint: TString;
migration: TObject<    {
v1Supported: TBoolean;
v1SupportedThrough: TString;
earliestRemoval: TString;
}>;
}>;

export declare class ProtocolV2NegotiationError extends Error {
    readonly code: "protocol_version_unsupported";
    constructor(range: ProtocolVersionRange);
}

export declare type ProtocolV2QueryRequest = Static<typeof ProtocolV2QueryRequestSchema>;

export declare const ProtocolV2QueryRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"query">;
params: TObject<    {
runId: TString;
}>;
}>;

export declare type ProtocolV2QueryResult = Static<typeof ProtocolV2QueryResultSchema>;

export declare const ProtocolV2QueryResultSchema: TObject<    {
schemaVersion: TLiteral<1>;
runId: TString;
derivedFromSequence: TInteger;
projection: TUnknown;
}>;

export declare type ProtocolV2Request = Static<typeof ProtocolV2RequestSchema>;

export declare const ProtocolV2RequestSchema: TUnion<[TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"initialize">;
params: TObject<    {
protocolRange: TObject<    {
minVersion: TString;
maxVersion: TString;
}>;
capabilities: TOptional<TArray<TString>>;
config: TOptional<TUnknown>;
configPath: TOptional<TString>;
configDir: TOptional<TString>;
cwd: TOptional<TString>;
sessionId: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"run">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"chat">;
params: TObject<    {
runId: TString;
agent: TString;
message: TString;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"resume">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"control">;
params: TUnion<[TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"cancel">;
reason: TOptional<TString>;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"approval">;
approvalId: TString;
decision: TUnion<[TLiteral<"allow">, TLiteral<"deny">]>;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"steering">;
message: TString;
}>, TObject<    {
runId: TString;
schemaVersion: TLiteral<1>;
controlId: TString;
type: TLiteral<"follow_up">;
message: TString;
}>]>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"events">;
params: TObject<    {
runId: TString;
afterSequence: TInteger;
limit: TOptional<TInteger>;
}>;
}>, TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"query">;
params: TObject<    {
runId: TString;
}>;
}>]>;

export declare type ProtocolV2ResumeRequest = Static<typeof ProtocolV2ResumeRequestSchema>;

export declare const ProtocolV2ResumeRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"resume">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>;

export declare type ProtocolV2RunHandle = Static<typeof ProtocolV2RunHandleSchema>;

export declare const ProtocolV2RunHandleSchema: TObject<    {
runId: TString;
acceptedAt: TString;
initialCursor: TLiteral<0>;
selectedProtocol: TLiteral<"2.0">;
availableControls: TArray<TUnion<[TLiteral<"cancel">, TLiteral<"approval">, TLiteral<"steering">, TLiteral<"follow_up">]>>;
}>;

export declare type ProtocolV2RunRequest = Static<typeof ProtocolV2RunRequestSchema>;

export declare const ProtocolV2RunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
protocolVersion: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"run">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>;

export declare type ProtocolV2StartRequest = ProtocolV2RunRequest | ProtocolV2ChatRequest | ProtocolV2ResumeRequest;

export declare class ProtocolV2ValidationError extends Error {
    constructor(message: string);
}

export declare class ProtocolValidationError extends Error {
    constructor(message: string);
}

export declare type ProtocolVersionRange = ProtocolV2InitializeRequest["params"]["protocolRange"];

export declare type PythonToolCallNotification = Static<typeof PythonToolCallNotificationSchema>;

export declare const PythonToolCallNotificationSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
method: TLiteral<"python_tool_call">;
params: TObject<    {
protocolVersion: TLiteral<"1.0">;
runId: TString;
callId: TString;
tool: TString;
args: TUnknown;
}>;
}>;

export declare const RegisterToolRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"register_tool">;
params: TObject<    {
name: TString;
description: TString;
parameters: TUnknown;
effect: TObject<    {
operations: TArray<TUnion<[TLiteral<"read">, TLiteral<"write">, TLiteral<"process">, TLiteral<"network">, TLiteral<"external">]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
label: TOptional<TString>;
}>;
}>;

export declare const ResumeRunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"resume_run">;
params: TObject<    {
runId: TString;
input: TOptional<TString>;
}>;
}>;

export declare type RpcId = Static<typeof RpcIdSchema>;

declare const RpcIdSchema: TUnion<[TString, TNumber]>;

export declare const RunRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"run">;
params: TObject<    {
input: TOptional<TString>;
qualityOverride: TOptional<TBoolean>;
runId: TOptional<TString>;
}>;
}>;

/** Worker、TypeScript SDK 与 Python SDK 共享的运行快照信封。 */
export declare const RunSnapshotSchema: TObject<    {
schemaVersion: TLiteral<1>;
runId: TString;
operation: TObject<    {
schemaVersion: TLiteral<1>;
operationId: TString;
runId: TString;
correlationId: TString;
state: TUnion<[TLiteral<"accepted">, TLiteral<"running">, TLiteral<"paused">, TLiteral<"aborting">, TLiteral<"completed">, TLiteral<"failed">]>;
transitionSequence: TInteger;
createdAt: TString;
updatedAt: TString;
pauseReason: TOptional<TString>;
failureReason: TOptional<TString>;
}>;
outcome: TObject<    {
status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"paused">, TLiteral<"aborted">, TLiteral<"timeout">, TLiteral<"budget_exceeded">]>;
finishReason: TString;
error: TOptional<TObject<    {
code: TUnsafe<"timeout" | "aborted" | "budget_exceeded" | "run_timeout" | "step_timeout" | "retry_limit" | "step_limit" | "approval_denied" | "tool_approval_denied" | "tool_execution_failed" | "policy_denied" | "loop_paused" | "unknown_effect" | "committed_effect_pending" | "context_budget_exhausted" | "context_capability_conflict" | "context_artifact_missing" | "unclassified_error" | "resume_input_mismatch" | "resume_config_mismatch" | "run_already_finished" | "operation_not_resumable" | "unknown_run" | "run_state_failed" | "durability_unsupported" | "durability_barrier_failed" | "fact_ledger_poisoned" | "fact_ledger_terminal" | "workspace_lease_recovery_required" | "child_run_orphan_audit_required" | "child_run_parent_mismatch" | "child_run_adapter_failed" | "child_run_policy_escalation" | "child_run_concurrency_limit" | "child_run_identity_mismatch" | "child_run_not_quiescent" | "child_run_unavailable" | "run_state_corrupt" | "run_state_conflict" | "run_state_locked" | "checkpoint_corrupt" | "checkpoint_conflict" | "checkpoint_failed" | "checkpoint_not_found" | "checkpoint_too_large" | "checkpoint_not_reversible" | "invalid_checkpoint_id" | "loop_snapshot_invalid" | "loop_snapshot_mismatch" | "loop_config_invalid" | "loop_state_invalid" | "operation_state_corrupt" | "invalid_operation_state" | "invalid_operation_transition" | "control_invalid" | "control_run_mismatch" | "session_migration_invalid" | "session_layout_conflict" | "invalid_session_id" | "session_restore_failed" | "session_migration_conflict" | "session_migration_failed" | "session_migration_unsupported" | "session_alias_failed" | "session_open_locked" | "invalid_run_id" | "invalid_config" | "invalid_tool" | "tool_capability_conflict" | "tool_lifecycle_invalid" | "effect_receipt_conflict" | "workspace_lease_invalid" | "workspace_lease_not_quiescent" | "environment_terminate_failed" | "context_lineage_corrupt" | "delegation_conflict" | "network_error" | "provider_unavailable" | "provider_timeout" | "provider_transient" | "rate_limit" | "workspace_busy" | "worker_closed" | "already_initialized" | "worker_busy" | "duplicate_tool" | "duplicate_tool_call" | "unknown_tool_call" | "python_tool_failed" | "unknown_approval" | "not_initialized" | "concurrent_run" | "control_unavailable" | "unknown_agent" | "unknown_provider" | "agent_failed" | "no_agent" | "no_prompt" | "no_models" | "loop_failed" | "loop_exhausted" | "loop_no_progress" | "verification_failed" | "retry_exhausted" | "quality_override_audit_failed" | "cursor_ahead" | "cursor_expired" | "run_id_conflict" | "protocol_validation_failed" | "protocol_version_mixed" | "protocol_version_unsupported" | "protocol_capability_missing" | "protocol_version_mismatch" | "invalid_run_handle" | "invalid_event_page" | "invalid_projection_query" | "invalid_control_receipt" | "invalid_run_snapshot" | "invalid_observability" | "parse_error" | "internal_error" | "coding_choice_required" | "coding_invalid_choice" | "coding_invalid_change" | "coding_verification_claim_mismatch" | "coding_delivery_not_verified" | "experiment_invalid" | "experiment_run_invalid" | "extension_invalid" | "extension_duplicate" | "extension_not_trusted" | "extension_capability_denied" | "dns" | "tls" | "http_401" | "http_429" | "exporter_failed" | "exporter_unavailable" | "egress_policy_missing" | "egress_policy_denied" | "configuration_mismatch" | "feedback_consent_missing" | "content_consent_missing" | "redaction_failed" | "environment_probe_failed" | "environment_capability_mismatch" | "environment_requirement_unsatisfied" | "environment_activity_conflict" | "git_command_failed" | "git_invalid_request" | "git_path_outside_workspace" | "process_timeout" | "process_aborted" | "process_output_limit" | "process_spawn_failed" | "diff_complexity_limit" | "diff_input_limit" | "diff_output_limit" | "diff_path_outside_workspace" | "unknown">;
message: TString;
audit: TOptional<TObject<    {
originalCode: TString;
}>>;
}>>;
}>;
metrics: TObject<    {
durationMs: TNumber;
turns: TInteger;
steps: TObject<    {
total: TInteger;
succeeded: TInteger;
failed: TInteger;
}>;
toolCalls: TInteger;
toolFailures: TInteger;
retries: TInteger;
tokens: TOptional<TNumber>;
costUsd: TOptional<TNumber>;
outputChars: TInteger;
context: TOptional<TObject<    {
inputTokens: TInteger;
outputTokens: TInteger;
cacheReadTokens: TInteger;
cacheWriteTokens: TInteger;
promptCacheStatus: TUnion<[TLiteral<"available">, TLiteral<"unavailable">, TLiteral<"unknown">]>;
compactions: TInteger;
lastSummaryFingerprint: TOptional<TString>;
stablePrefixFingerprints: TArray<TString>;
lastBudget: TOptional<TObject<    {
providerId: TString;
modelId: TString;
capabilityFingerprint: TString;
source: TUnion<[TLiteral<"locked_catalog">, TLiteral<"explicit_config">, TLiteral<"provider_metadata">, TLiteral<"conservative_fallback">]>;
confidence: TUnion<[TLiteral<"verified">, TLiteral<"declared">, TLiteral<"assumed">]>;
effectiveContextWindow: TInteger;
reservedOutputTokens: TInteger;
availableInputTokens: TInteger;
messageTokens: TInteger;
estimator: TLiteral<"pi-agent-core-estimate-v1">;
}>>;
}>>;
artifacts: TOptional<TObject<    {
stored: TInteger;
blocked: TInteger;
totalBytes: TInteger;
}>>;
}>;
evaluation: TObject<    {
profile: TUnion<[TLiteral<"development">, TLiteral<"standard">, TLiteral<"strict">]>;
scenarioResults: TArray<TObject<    {
id: TString;
passed: TBoolean;
score: TOptional<TNumber>;
reason: TOptional<TString>;
}>>;
qualityScores: TRecord<TString, TNumber>;
securityFindings: TArray<TString>;
}>;
releaseReadiness: TObject<    {
ready: TBoolean;
blockers: TArray<TString>;
warnings: TArray<TString>;
overrideRecord: TOptional<TObject<    {
reason: TString;
recordedAt: TString;
}>>;
}>;
trace: TArray<TObject<    {
eventId: TString;
runId: TString;
sequence: TInteger;
timestamp: TString;
event: TObject<    {
type: TString;
}>;
}>>;
checkpoints: TArray<TObject<    {
version: TLiteral<1>;
checkpointId: TString;
runId: TString;
operationId: TOptional<TString>;
toolCallId: TOptional<TString>;
idempotencyKey: TOptional<TString>;
timestamp: TString;
tool: TString;
reversible: TBoolean;
targetPath: TOptional<TString>;
existed: TOptional<TBoolean>;
beforeSha256: TOptional<TString>;
afterExisted: TOptional<TBoolean>;
afterSha256: TOptional<TString>;
reason: TOptional<TString>;
snapshotFile: TString;
}>>;
artifacts: TArray<TObject<    {
artifactId: TString;
status: TUnion<[TLiteral<"stored">, TLiteral<"blocked">]>;
relativePath: TOptional<TString>;
sizeBytes: TInteger;
sha256: TOptional<TString>;
mediaType: TString;
createdAt: TString;
retention: TLiteral<"run">;
redaction: TUnion<[TLiteral<"none">, TLiteral<"blocked-secret">]>;
}>>;
extensions: TArray<TObject<    {
extensionId: TString;
extensionVersion: TString;
event: TUnion<[TLiteral<"before-model">, TLiteral<"before-tool">, TLiteral<"after-tool">, TLiteral<"run-finished">]>;
status: TUnion<[TLiteral<"succeeded">, TLiteral<"failed">, TLiteral<"timed_out">]>;
durationMs: TNumber;
error: TOptional<TString>;
denied: TOptional<TBoolean>;
}>>;
resumable: TBoolean;
}>;

export declare const ToolResultRequestSchema: TObject<    {
jsonrpc: TLiteral<"2.0">;
id: TUnion<[TString, TNumber]>;
method: TLiteral<"tool_result">;
params: TObject<    {
callId: TString;
result: TOptional<TUnknown>;
error: TOptional<TString>;
}>;
}>;

export { }
