import { ERROR_CODES, type ErrorCodeInfo, type ErrorRetryClass } from "coremind-protocol";

export {
  ERROR_CODES,
  type ErrorCancelClass,
  type ErrorCode,
  type ErrorCodeInfo,
  type ErrorHumanAction,
  type ErrorRetryClass,
  type ErrorRunStatus,
  type ErrorTerminality,
  isErrorCode,
  type NormalizedExternalErrorCode,
  normalizeExternalErrorCode,
} from "coremind-protocol";

/** 从码表派生终态映射（替代 run-terminalizer 的自有 statusFromCode 字符串集合）。 */
export function terminalStatusForCode(
  code: string,
): "paused" | "aborted" | "timeout" | "budget_exceeded" | "failed" {
  return codeInfo(code)?.runStatus ?? "failed";
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
export class CoreMindError<Code extends string = string> extends Error {
  /** 机器可读错误码；分类语义见 ERROR_CODES 码表 */
  readonly code: Code;
  /** 未知外部错误的脱敏审计值；不得作为公开错误码重新解释。 */
  readonly audit?: { originalCode: string };

  constructor(code: Code, message: string, audit?: { originalCode: string }) {
    super(message);
    this.name = "CoreMindError";
    this.code = code;
    this.audit = audit;
  }
}
