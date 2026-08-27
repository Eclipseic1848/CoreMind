import type { ConfigParseErrorCode, ConfigValidationErrorCode } from "coremind-config";
import type {
  DiffLimitErrorCode,
  GitAdapterErrorCode,
  ProcessRunnerErrorCode,
} from "coremind-tools";
import type { ExecutionEnvironmentErrorCode } from "coremind-tools/internal";
import type { ContextLifecycleErrorCode } from "./context-lifecycle.js";
import type {
  CodingKernelErrorCode,
  CoreMindError,
  ErrorCode,
  ExperimentErrorCode,
  LifecycleExtensionErrorCode,
  RunOutcome,
  TelemetryFailureCode,
} from "./index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _CoreMindErrorConstructorRemainsCompatible = Expect<
  Equal<ConstructorParameters<typeof CoreMindError>[0], string>
>;

type ExistingOwnedErrorCode =
  | ConfigParseErrorCode
  | ConfigValidationErrorCode
  | CodingKernelErrorCode
  | ContextLifecycleErrorCode
  | ExperimentErrorCode
  | LifecycleExtensionErrorCode
  | TelemetryFailureCode
  | ExecutionEnvironmentErrorCode
  | GitAdapterErrorCode
  | ProcessRunnerErrorCode
  | DiffLimitErrorCode;

type _ExistingOwnedErrorsAreRegistered = Expect<
  Equal<Exclude<ExistingOwnedErrorCode, ErrorCode>, never>
>;

function rejectsUnregisteredErrorCode(): void {
  // @ts-expect-error 未登记错误码必须在编译期被拒绝
  const code: ErrorCode = "vendor_private_error";
  void code;
}

void rejectsUnregisteredErrorCode;

function rejectsUnregisteredRunOutcome(): void {
  const outcome: RunOutcome = {
    status: "failed",
    finishReason: "vendor_private_error",
    // @ts-expect-error 公开 Outcome 不得携带未登记错误码
    error: { code: "vendor_private_error", message: "私有错误" },
  };
  void outcome;
}

void rejectsUnregisteredRunOutcome;
