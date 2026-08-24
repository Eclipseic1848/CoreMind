import { describe, expect, it } from "vitest";
import {
  CoreMindError,
  cancelSignalForCode,
  ERROR_CODES,
  retryClassForCode,
  terminalStatusForCode,
} from "./errors.js";

// 规格 03（docs/spec/0.3.x-a/03-cancellation-and-quiescence.md §2）列出的码表契约。
const SPEC_CODES = {
  取消类: ["aborted", "run_timeout", "step_timeout", "budget_exceeded"],
  暂停类: ["loop_paused", "tool_approval_denied"],
  恢复类: [
    "resume_input_mismatch",
    "run_already_finished",
    "operation_not_resumable",
    "committed_effect_pending",
    "unknown_effect",
  ],
  损坏类: [
    "run_state_corrupt",
    "run_state_conflict",
    "run_state_locked",
    "checkpoint_corrupt",
    "checkpoint_conflict",
    "loop_snapshot_invalid",
    "loop_snapshot_mismatch",
    "session_layout_conflict",
  ],
} as const;

// 现有代码构造点使用的全部错误码（快照）：码表不得遗漏任何现存码，否则对外字符串行为变化。
const EXISTING_CODES = [
  // 取消/终态
  "aborted",
  "run_timeout",
  "step_timeout",
  "budget_exceeded",
  "retry_limit",
  "step_limit",
  // 暂停/人工
  "approval_denied",
  "tool_approval_denied",
  "policy_denied",
  "loop_paused",
  "unknown_effect",
  "committed_effect_pending",
  "context_budget_exhausted",
  "context_capability_conflict",
  "context_artifact_missing",
  // 恢复
  "resume_input_mismatch",
  "resume_config_mismatch",
  "run_already_finished",
  "operation_not_resumable",
  "unknown_run",
  "run_state_failed",
  // 损坏/无效
  "run_state_corrupt",
  "run_state_conflict",
  "run_state_locked",
  "checkpoint_corrupt",
  "checkpoint_conflict",
  "checkpoint_failed",
  "checkpoint_not_found",
  "checkpoint_too_large",
  "invalid_checkpoint_id",
  "loop_snapshot_invalid",
  "loop_snapshot_mismatch",
  "loop_config_invalid",
  "loop_state_invalid",
  "operation_state_corrupt",
  "invalid_operation_state",
  "session_migration_invalid",
  "session_layout_conflict",
  "invalid_run_id",
  "invalid_config",
  "invalid_tool",
  "tool_capability_conflict",
  "tool_lifecycle_invalid",
  "durability_unsupported",
  "durability_barrier_failed",
  "fact_ledger_poisoned",
  "fact_ledger_terminal",
  "context_lineage_corrupt",
  // 瞬态
  "network_error",
  "provider_unavailable",
  "provider_timeout",
  "provider_transient",
  "rate_limit",
  // worker
  "worker_closed",
  "already_initialized",
  "worker_busy",
  "duplicate_tool",
  "duplicate_tool_call",
  "unknown_tool_call",
  "python_tool_failed",
  "unknown_approval",
  "not_initialized",
  "concurrent_run",
  // 其他
  "unknown_agent",
  "agent_failed",
  "no_models",
  "unknown",
] as const;

describe("错误码码表（单一事实源）", () => {
  it("包含规格 03 列出的全部码", () => {
    for (const group of Object.values(SPEC_CODES)) {
      for (const code of group) {
        expect(ERROR_CODES[code], `缺少规格码：${code}`).toBeDefined();
      }
    }
  });

  it("包含现有构造点使用的全部码（快照，防遗漏）", () => {
    for (const code of EXISTING_CODES) {
      expect(ERROR_CODES[code], `码表缺少现有码：${code}`).toBeDefined();
    }
  });

  it("每个码都有三个分类属性", () => {
    for (const [code, info] of Object.entries(ERROR_CODES)) {
      expect(info.terminality, `${code}.terminality`).toMatch(/^(terminal|pausable|transient)$/);
      expect(info.cancelClass, `${code}.cancelClass`).toMatch(
        /^(cancel|timeout|budget|human|corruption|other)$/,
      );
      expect(info.retryClass, `${code}.retryClass`).toMatch(/^(human|transient|fatal)$/);
    }
  });

  it("规格码的取消分类与规格 03 一致", () => {
    expect(ERROR_CODES.aborted.cancelClass).toBe("cancel");
    expect(ERROR_CODES.run_timeout.cancelClass).toBe("timeout");
    expect(ERROR_CODES.step_timeout.cancelClass).toBe("timeout");
    expect(ERROR_CODES.budget_exceeded.cancelClass).toBe("budget");
    expect(ERROR_CODES.loop_paused.cancelClass).toBe("human");
    expect(ERROR_CODES.tool_approval_denied.cancelClass).toBe("human");
    const corruptionCodes = SPEC_CODES.损坏类 as readonly string[];
    for (const code of [...SPEC_CODES.恢复类, ...SPEC_CODES.损坏类]) {
      expect(ERROR_CODES[code].cancelClass, code).toBe(
        corruptionCodes.includes(code) ? "corruption" : "human",
      );
    }
  });

  it("terminalStatusForCode 从码表派生，未知码失败关闭", () => {
    expect(terminalStatusForCode("loop_paused")).toBe("paused");
    expect(terminalStatusForCode("aborted")).toBe("aborted");
    expect(terminalStatusForCode("run_timeout")).toBe("timeout");
    expect(terminalStatusForCode("step_timeout")).toBe("timeout");
    expect(terminalStatusForCode("budget_exceeded")).toBe("budget_exceeded");
    expect(terminalStatusForCode("retry_limit")).toBe("budget_exceeded");
    expect(terminalStatusForCode("approval_denied")).toBe("failed");
    expect(terminalStatusForCode("workspace_lease_recovery_required")).toBe("paused");
    expect(terminalStatusForCode("context_budget_exhausted")).toBe("paused");
    expect(terminalStatusForCode("context_lineage_corrupt")).toBe("failed");
    expect(terminalStatusForCode("run_state_corrupt")).toBe("failed");
    expect(terminalStatusForCode("unknown_agent")).toBe("failed");
    expect(terminalStatusForCode("not_a_real_code")).toBe("failed");
  });

  it("cancelSignalForCode 从码表派生，未知码失败关闭", () => {
    expect(cancelSignalForCode("aborted")).toBe("abort");
    expect(cancelSignalForCode("run_timeout")).toBe("timeout");
    expect(cancelSignalForCode("budget_exceeded")).toBe("budget_exceeded");
    expect(cancelSignalForCode("approval_denied")).toBe("pause");
    expect(cancelSignalForCode("loop_paused")).toBe("pause");
    expect(cancelSignalForCode("context_budget_exhausted")).toBe("pause");
    // 恢复类码是 cancelClass=human 但 retryClass=fatal：现状语义为 FAIL 而非 PAUSE
    expect(cancelSignalForCode("resume_input_mismatch")).toBe("fail");
    expect(cancelSignalForCode("run_state_corrupt")).toBe("fail");
    expect(cancelSignalForCode("unknown_agent")).toBe("fail");
    expect(cancelSignalForCode("not_a_real_code")).toBe("fail");
  });

  it("retryClassForCode 查询码表，未知码返回 undefined", () => {
    expect(retryClassForCode("approval_denied")).toBe("human");
    expect(retryClassForCode("network_error")).toBe("transient");
    expect(retryClassForCode("aborted")).toBe("fatal");
    expect(retryClassForCode("not_a_real_code")).toBeUndefined();
  });

  it("CoreMindError 保留错误码、名称与消息", () => {
    const error = new CoreMindError("aborted", "执行已中止");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CoreMindError");
    expect(error.code).toBe("aborted");
    expect(error.message).toBe("执行已中止");
  });
});
