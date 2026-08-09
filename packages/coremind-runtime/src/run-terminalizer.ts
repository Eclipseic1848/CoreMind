import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import type { RunOutcome, RunStatus } from "./result.js";

/**
 * 把一次运行的所有结束路径收敛为稳定终态。
 *
 * 调用方只需要判断 RunOutcome，不需要同时处理“返回值”和“抛异常”两套协议。
 */
export class RunTerminalizer {
  terminalize(events: CoreMindEvent[], error?: unknown): RunOutcome {
    if (error !== undefined) return outcomeFromError(error);
    if (events.some((event) => event.type === "policy_denied")) {
      return { status: "paused", finishReason: "tool_approval_denied" };
    }
    return { status: "succeeded", finishReason: "completed" };
  }
}

function outcomeFromError(error: unknown): RunOutcome {
  const code = error instanceof CoreMindError ? error.code : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  return {
    status: statusFromCode(code),
    finishReason: code,
    error: { code, message },
  };
}

function statusFromCode(code: string): RunStatus {
  if (code === "loop_paused") return "paused";
  if (code === "aborted") return "aborted";
  if (code === "run_timeout" || code === "step_timeout") return "timeout";
  if (code === "budget_exceeded" || code === "retry_limit" || code === "step_limit") {
    return "budget_exceeded";
  }
  return "failed";
}
