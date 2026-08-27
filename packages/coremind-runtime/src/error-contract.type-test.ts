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
