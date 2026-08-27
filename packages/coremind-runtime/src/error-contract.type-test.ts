import { CoreMindError, type ErrorCode } from "./index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type _CoreMindErrorCodeIsRegistered = Expect<
  Equal<ConstructorParameters<typeof CoreMindError>[0], ErrorCode>
>;

function rejectsUnregisteredCode(): void {
  // @ts-expect-error 未登记错误码必须在编译期被拒绝
  new CoreMindError("vendor_private_error", "不应成为公开错误码");
}

void rejectsUnregisteredCode;
