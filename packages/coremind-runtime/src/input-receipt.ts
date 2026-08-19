import { createHash, randomUUID } from "node:crypto";
import type { CoreMindEvent } from "./events.js";

/**
 * 输入收据与静止判定（规格 docs/spec/0.3.x-a/03-cancellation-and-quiescence.md §4）。
 *
 * 每个外部输入获得稳定 ID 与四态收据：
 *
 * ```
 * pending → claimed → completed
 *         ↘ discarded
 * ```
 *
 * - pending：输入已收到、尚未被任何活动消费
 * - claimed：输入被一个 Run/Turn 认领（绑定 TurnId）
 * - discarded：因取消/竞态被明确丢弃（如 abort 后到达的排队输入）
 * - completed：输入对应的活动已终态
 *
 * 状态转移是追加事件（input_claimed / input_completed / input_discarded），由事件序列
 * 折叠出当前状态——不覆盖旧记录。折叠遇到非法转移（无回退）抛错，语义损坏 fail closed。
 */

/** 品牌化的输入 ID（规格 02：跨 Run/Turn 稳定；协议边界序列化为 string） */
export type InputId = string & { readonly __brand: "InputId" };

export type InputReceiptStatus = "pending" | "claimed" | "completed" | "discarded";

/**
 * 四态机的合法转移表：pending 可到 claimed/discarded，claimed 可到 completed；
 * claimed → discarded 允许（规格 03 §4 验收：abort 后已认领但未完成的输入收到
 * discarded 收据——如 headless run 在首个 Turn 认领后中止）。任何状态无回退。
 */
const TRANSITIONS: Record<InputReceiptStatus, readonly InputReceiptStatus[]> = {
  pending: ["claimed", "discarded"],
  claimed: ["completed", "discarded"],
  completed: [],
  discarded: [],
};

/** 输入正文的稳定短指纹（sha256 前 16 位）：Trace 只保存摘要，不落原文 */
export function inputFingerprint(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** 生成新的输入 ID（与 RunId/TurnId 同源的 randomUUID 品牌类型） */
export function newInputId(): InputId {
  return randomUUID() as InputId;
}

/** 转移合法性：undefined（未登记）只能到 pending（登记）；否则按转移表 */
export function isValidTransition(
  from: InputReceiptStatus | undefined,
  to: InputReceiptStatus,
): boolean {
  if (from === undefined) return to === "pending";
  return TRANSITIONS[from].includes(to);
}

export interface InputReceiptEventOptions {
  inputId: InputId;
  timestamp?: string;
}

export interface ClaimInputOptions extends InputReceiptEventOptions {
  turnId: string;
}

export interface CreateInputReceiptOptions extends InputReceiptEventOptions {
  contentFingerprint: string;
}

function stamp(options: InputReceiptEventOptions): string {
  return options.timestamp ?? new Date().toISOString();
}

/** 输入到达：生成 pending 收据事件（带输入指纹与时间戳） */
export function createInputReceipt(options: CreateInputReceiptOptions): CoreMindEvent {
  return {
    type: "input_receipt",
    inputId: options.inputId,
    status: "pending",
    contentFingerprint: options.contentFingerprint,
    timestamp: stamp(options),
  };
}

/** 输入被认领：生成 claimed 事件（绑定 TurnId） */
export function claimInput(options: ClaimInputOptions): CoreMindEvent {
  return {
    type: "input_claimed",
    inputId: options.inputId,
    status: "claimed",
    turnId: options.turnId,
    timestamp: stamp(options),
  };
}

/** 输入对应活动已终态：生成 completed 事件 */
export function completeInput(options: InputReceiptEventOptions): CoreMindEvent {
  return {
    type: "input_completed",
    inputId: options.inputId,
    status: "completed",
    timestamp: stamp(options),
  };
}

/** 输入被明确丢弃：生成 discarded 事件 */
export function discardInput(options: InputReceiptEventOptions): CoreMindEvent {
  return {
    type: "input_discarded",
    inputId: options.inputId,
    status: "discarded",
    timestamp: stamp(options),
  };
}

/** 该事件是否属于输入收据事件族（折叠时过滤用） */
export function isInputReceiptEvent(event: CoreMindEvent): boolean {
  return (
    event.type === "input_receipt" ||
    event.type === "input_claimed" ||
    event.type === "input_completed" ||
    event.type === "input_discarded"
  );
}

interface ReceiptEventShape {
  inputId?: unknown;
  status?: unknown;
}

/**
 * 从事件序列折叠每个输入的当前状态（规格 §4：状态由事件序列折叠，不覆盖旧记录）。
 * 非法转移（completed/discarded 后再次推进、未登记就转移）抛错——语义损坏 fail closed。
 * 事件乱序时按 inputId 独立推进（同一输入的事件仍按到达顺序判定转移）。
 */
export function foldInputReceipts(
  events: readonly CoreMindEvent[],
): Map<InputId, InputReceiptStatus> {
  const state = new Map<InputId, InputReceiptStatus>();
  for (const event of events) {
    if (!isInputReceiptEvent(event)) continue;
    const receipt = event as ReceiptEventShape;
    if (receipt.inputId === undefined) continue;
    const inputId = String(receipt.inputId) as InputId;
    const to = receipt.status as InputReceiptStatus;
    const from = state.get(inputId);
    if (!isValidTransition(from, to)) {
      throw new Error(
        `输入收据非法转移：${inputId} ${from ?? "（未登记）"} → ${to}（四态机无回退）`,
      );
    }
    state.set(inputId, to);
  }
  return state;
}

/** 事件序列中某输入的最新收据状态（折叠查询的便捷封装） */
export function receiptStatusOf(
  events: readonly CoreMindEvent[],
  inputId: InputId,
): InputReceiptStatus | undefined {
  return foldInputReceipts(events).get(inputId);
}
