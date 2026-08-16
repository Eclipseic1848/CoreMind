/**
 * 品牌 ID 类型与派生规则（规格 docs/spec/0.3.x-a/02-identity-and-invariants.md §2）。
 *
 * 品牌类型只存在于 TS 内部，编译期防止跨 Run/Turn/Step/Call 等错配；
 * 协议边界（JSON-RPC / CLI 输出）仍序列化为字符串，公共导出面保持 string（决策 D-5）。
 */

/** 运行标识：一次完整执行尝试 */
export type RunId = string & { readonly __brand: "RunId" };
/** 回合标识：Agent 与 Provider 的一次请求-响应回合 */
export type TurnId = string & { readonly __brand: "TurnId" };
/** 步骤标识：Loop/Workflow 的稳定执行单元，Run 内唯一 */
export type StepId = string & { readonly __brand: "StepId" };
/** 工具调用标识：透传上游 toolCallId */
export type CallId = string & { readonly __brand: "CallId" };
/** 审批标识 */
export type ApprovalId = string & { readonly __brand: "ApprovalId" };
/** 副作用收据标识：规范化 idempotencyKey */
export type ReceiptId = string & { readonly __brand: "ReceiptId" };
/** 检查点标识 */
export type CheckpointId = string & { readonly __brand: "CheckpointId" };

/**
 * ReceiptId 的单点派生规则（替代 run-effect-coordinator 与 runtime 的两处重复实现）：
 * 有 stepId 时为 `runId:stepId:callId`，否则为 `runId:callId`。
 */
export function receiptId(runId: string, stepId: string | undefined, callId: string): ReceiptId {
  return (stepId ? `${runId}:${stepId}:${callId}` : `${runId}:${callId}`) as ReceiptId;
}

/**
 * 0.3.0 旧格式 StepId 的读取兼容映射（不重写持久记录）：
 * - 旧 `loop-execute` 无 iteration 后缀，任意新键 `loop-execute:N` 都回退到它；
 * - 旧 `loop-verify-N` / `loop-repair-N` 用连字符，与新键 `loop-verify:N` / `loop-repair:N` 一一对应；
 * - 非 loop 模板键无 legacy 形式，返回 undefined。
 */
export function legacyStepId(stepId: string): string | undefined {
  const match = /^loop-(execute|verify|repair):(\d+)$/.exec(stepId);
  if (!match) return undefined;
  const [, kind, iteration] = match;
  return kind === "execute" ? "loop-execute" : `loop-${kind}-${iteration}`;
}
