import type {
  DiffLimitErrorCode,
  GitAdapterErrorCode,
  ProcessRunnerErrorCode,
} from "coremind-tools";
import type { ExecutionEnvironmentErrorCode } from "coremind-tools/internal";
import type { ContextLifecycleErrorCode } from "./context-lifecycle.js";
import type {
  CodingKernelErrorCode,
  ExperimentErrorCode,
  LifecycleExtensionErrorCode,
  TelemetryFailureCode,
} from "./index.js";
import { CoreMindError, type ErrorCode } from "./index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _CoreMindErrorCodeIsRegistered = Expect<
  Equal<ConstructorParameters<typeof CoreMindError>[0], ErrorCode>
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

function rejectsUnregisteredCode(): void {
  // @ts-expect-error 未登记错误码必须在编译期被拒绝
  new CoreMindError("vendor_private_error", "不应成为公开错误码");
}

void rejectsUnregisteredCode;
