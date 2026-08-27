import { CoreMindError, terminalStatusForCode } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { normalizeExecutionError } from "./execution-error.js";
import type { RunOutcome } from "./result.js";

/**
 * 把一次运行的所有结束路径收敛为稳定终态。
 *
 * 调用方只需要判断 RunOutcome，不需要同时处理“返回值”和“抛异常”两套协议。
 */
export class RunTerminalizer {
  terminalize(events: CoreMindEvent[], error?: unknown): RunOutcome {
    if (
      events.some((event) => event.type === "policy_denied") &&
      (error === undefined || (error instanceof CoreMindError && error.code === "loop_paused"))
    ) {
      return { status: "paused", finishReason: "tool_approval_denied" };
    }
    if (error !== undefined) return outcomeFromError(error);
    return { status: "succeeded", finishReason: "completed" };
  }
}

function outcomeFromError(error: unknown): RunOutcome {
  const normalized = normalizeExecutionError(error);
  const { code, message, audit } = normalized;
  return {
    status: terminalStatusForCode(code),
    finishReason: code,
    error: { code, message, ...(audit ? { audit } : {}) },
  };
}
