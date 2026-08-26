import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { CoreMindError } from "./errors.js";
import type { ApprovalId, ControlId, RunId } from "./ids.js";
import type { RunStateJournal, RunStateRecord } from "./run-state.js";

interface RunControlBase {
  schemaVersion: 1;
  controlId: string;
  runId: string;
}

export type RunControlCommand =
  | (RunControlBase & { type: "cancel"; reason?: string })
  | (RunControlBase & {
      type: "approval";
      approvalId: string;
      decision: "allow" | "deny";
    })
  | (RunControlBase & { type: "steering"; message: string })
  | (RunControlBase & { type: "follow_up"; message: string });

interface InternalRunControlBase {
  schemaVersion: 1;
  controlId: ControlId;
  runId: RunId;
}

export type InternalRunControlCommand =
  | (InternalRunControlBase & { type: "cancel"; reason?: string })
  | (InternalRunControlBase & {
      type: "approval";
      approvalId: ApprovalId;
      decision: "allow" | "deny";
    })
  | (InternalRunControlBase & { type: "steering"; message: string })
  | (InternalRunControlBase & { type: "follow_up"; message: string });

export type ControlReceiptStatus = "accepted" | "applied" | "rejected" | "duplicate" | "conflict";

export interface ControlReceipt {
  schemaVersion: 1;
  controlId: string;
  runId: string;
  status: ControlReceiptStatus;
  acceptedSequence?: number;
  appliedSequence?: number;
  rejectedSequence?: number;
  duplicateOf?: "accepted" | "applied" | "rejected";
  reason?: string;
}

export type ControlApplyResult =
  | "accepted"
  | "applied"
  | {
      status: "applied";
      /** applied Fact 稳定提交后执行；实现必须保证不抛错。 */
      afterDurable?: () => void | Promise<void>;
    }
  | { status: "rejected"; reason: string };

interface InternalControlInboxOptions {
  runId: RunId;
  journal: RunStateJournal;
  records: readonly RunStateRecord[];
  apply: (command: InternalRunControlCommand) => Promise<ControlApplyResult>;
}

export interface PendingControlProjection {
  source: "control_inbox";
  controlId: string;
  runId: string;
  type: RunControlCommand["type"];
  acceptedSequence: number;
  command: RunControlCommand;
}

type StoredControlState = "accepted" | "applied" | "rejected";

interface StoredControl {
  command: InternalRunControlCommand;
  fingerprint: string;
  state: StoredControlState;
  acceptedSequence: number;
  appliedSequence?: number;
  rejectedSequence?: number;
  reason?: string;
}

interface ControlFact {
  schemaVersion: 1;
  controlId: string;
  fingerprint: string;
  state: StoredControlState;
  command?: RunControlCommand;
  reason?: string;
}

/** 持久控制收件箱；所有状态变化都复用当前 RunStateJournal 的单一 Fact writer。 */
export class ControlInbox {
  private readonly controls: Map<ControlId, StoredControl>;

  constructor(private readonly options: InternalControlInboxOptions) {
    if (options.journal.runId !== options.runId) {
      throw new CoreMindError("control_run_mismatch", "ControlInbox 与 journal 的 runId 不一致");
    }
    this.controls = restoreControls(options.runId, options.records);
  }

  async accept(command: RunControlCommand): Promise<ControlReceipt> {
    const internalCommand = validateCommand(command, this.options.runId);
    const fingerprint = controlFingerprint(internalCommand);
    const existing = this.controls.get(internalCommand.controlId);
    if (existing) return duplicateOrConflict(internalCommand, fingerprint, existing);

    const accepted = await this.options.journal.appendFact(
      "control",
      {
        schemaVersion: 1,
        controlId: internalCommand.controlId,
        fingerprint,
        state: "accepted",
        command: structuredClone(internalCommand),
      } satisfies ControlFact,
      { durability: "critical" },
    );
    const stored: StoredControl = {
      command: structuredClone(internalCommand),
      fingerprint,
      state: "accepted",
      acceptedSequence: accepted.sequence,
    };
    this.controls.set(internalCommand.controlId, stored);

    return this.applyStored(stored);
  }

  async applyPending(): Promise<ControlReceipt[]> {
    const receipts: ControlReceipt[] = [];
    for (const stored of this.controls.values()) {
      if (stored.state === "accepted") receipts.push(await this.applyStored(stored));
    }
    return receipts;
  }

  private async applyStored(stored: StoredControl): Promise<ControlReceipt> {
    const command = stored.command;
    let result: ControlApplyResult;
    try {
      result = await this.options.apply(structuredClone(command));
    } catch (error) {
      result = {
        status: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (result === "accepted") {
      return receiptFor(command, "accepted", { acceptedSequence: stored.acceptedSequence });
    }
    if (result === "applied" || result.status === "applied") {
      const applied = await this.appendResolution(stored, "applied");
      if (result !== "applied") await result.afterDurable?.();
      return receiptFor(command, "applied", { appliedSequence: applied.sequence });
    }
    const rejected = await this.appendResolution(stored, "rejected", result.reason);
    return receiptFor(command, "rejected", {
      rejectedSequence: rejected.sequence,
      reason: result.reason,
    });
  }

  private async appendResolution(
    stored: StoredControl,
    state: "applied" | "rejected",
    reason?: string,
  ) {
    const receipt = await this.options.journal.appendFact(
      "control",
      {
        schemaVersion: 1,
        controlId: stored.command.controlId,
        fingerprint: stored.fingerprint,
        state,
        ...(reason ? { reason } : {}),
      } satisfies ControlFact,
      { durability: "critical" },
    );
    stored.state = state;
    if (state === "applied") stored.appliedSequence = receipt.sequence;
    else {
      stored.rejectedSequence = receipt.sequence;
      stored.reason = reason;
    }
    return receipt;
  }
}

/** 从持久 Control Facts 重建尚未 applied/rejected 的控制，不读取连接内存。 */
export function projectPendingControlFacts(
  runId: string,
  records: readonly RunStateRecord[],
): PendingControlProjection[] {
  if (runId.trim().length === 0) {
    throw new CoreMindError("invalid_run_id", "Control Projection 的 runId 不能为空");
  }
  const internalRunId = runId as RunId;
  return [...restoreControls(internalRunId, records).values()].flatMap((stored) =>
    stored.state === "accepted"
      ? [
          {
            source: "control_inbox" as const,
            controlId: stored.command.controlId,
            runId,
            type: stored.command.type,
            acceptedSequence: stored.acceptedSequence,
            command: structuredClone(stored.command),
          },
        ]
      : [],
  );
}

function duplicateOrConflict(
  command: RunControlCommand,
  fingerprint: string,
  existing: StoredControl,
): ControlReceipt {
  if (existing.fingerprint !== fingerprint) {
    return receiptFor(command, "conflict", {
      reason: `controlId ${command.controlId} 已绑定不同内容`,
    });
  }
  return receiptFor(command, "duplicate", {
    duplicateOf: existing.state,
    ...(existing.state === "accepted" ? { acceptedSequence: existing.acceptedSequence } : {}),
    ...(existing.appliedSequence !== undefined
      ? { appliedSequence: existing.appliedSequence }
      : {}),
    ...(existing.rejectedSequence !== undefined
      ? { rejectedSequence: existing.rejectedSequence }
      : {}),
    ...(existing.reason ? { reason: existing.reason } : {}),
  });
}

function restoreControls(
  runId: RunId,
  records: readonly RunStateRecord[],
): Map<ControlId, StoredControl> {
  const controls = new Map<ControlId, StoredControl>();
  for (const record of [...records].sort((left, right) => left.sequence - right.sequence)) {
    if (record.runId !== runId) {
      throw new CoreMindError("run_state_corrupt", "Control Fact 混入了其他 runId");
    }
    if (record.kind !== "control") continue;
    const fact = parseControlFact(record.payload);
    const factControlId = fact.controlId as ControlId;
    const existing = controls.get(factControlId);
    if (fact.state === "accepted") {
      if (existing || !fact.command) {
        throw new CoreMindError(
          "run_state_corrupt",
          `Control ${fact.controlId} 的 accepted Fact 非法`,
        );
      }
      const command = validateCommand(fact.command, runId);
      if (controlFingerprint(command) !== fact.fingerprint) {
        throw new CoreMindError("run_state_corrupt", `Control ${fact.controlId} 的指纹不匹配`);
      }
      controls.set(command.controlId, {
        command: structuredClone(command),
        fingerprint: fact.fingerprint,
        state: "accepted",
        acceptedSequence: record.sequence,
      });
      continue;
    }
    if (existing?.state !== "accepted" || existing.fingerprint !== fact.fingerprint) {
      throw new CoreMindError("run_state_corrupt", `Control ${fact.controlId} 的状态转换非法`);
    }
    existing.state = fact.state;
    if (fact.state === "applied") existing.appliedSequence = record.sequence;
    else {
      existing.rejectedSequence = record.sequence;
      existing.reason = fact.reason;
    }
  }
  return controls;
}

function parseControlFact(value: unknown): ControlFact {
  if (value === null || typeof value !== "object") {
    throw new CoreMindError("run_state_corrupt", "Control Fact 不是对象");
  }
  const fact = value as Partial<ControlFact>;
  if (
    fact.schemaVersion !== 1 ||
    typeof fact.controlId !== "string" ||
    fact.controlId.length === 0 ||
    typeof fact.fingerprint !== "string" ||
    !["accepted", "applied", "rejected"].includes(fact.state ?? "")
  ) {
    throw new CoreMindError("run_state_corrupt", "Control Fact 合同非法");
  }
  return fact as ControlFact;
}

function validateCommand(command: RunControlCommand, runId: RunId): InternalRunControlCommand {
  const value = command as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreMindError("control_invalid", "Control 命令合同非法或 runId 不匹配");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    candidate.runId !== runId ||
    typeof candidate.controlId !== "string" ||
    candidate.controlId.trim().length === 0 ||
    !["cancel", "approval", "steering", "follow_up"].includes(String(candidate.type))
  ) {
    throw new CoreMindError("control_invalid", "Control 命令合同非法或 runId 不匹配");
  }
  const validTypeSpecificFields =
    (candidate.type === "cancel" &&
      (candidate.reason === undefined || typeof candidate.reason === "string")) ||
    (candidate.type === "approval" &&
      typeof candidate.approvalId === "string" &&
      candidate.approvalId.length > 0 &&
      (candidate.decision === "allow" || candidate.decision === "deny")) ||
    ((candidate.type === "steering" || candidate.type === "follow_up") &&
      typeof candidate.message === "string" &&
      candidate.message.length > 0);
  if (!validTypeSpecificFields) {
    throw new CoreMindError("control_invalid", "Control 命令类型专属字段非法");
  }
  // 协议/Fact 边界保留字符串；只有完成全部运行时校验后才进入内部品牌类型。
  return command as InternalRunControlCommand;
}

function controlFingerprint(command: RunControlCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

function receiptFor(
  command: RunControlCommand,
  status: ControlReceiptStatus,
  details: Omit<ControlReceipt, "schemaVersion" | "controlId" | "runId" | "status"> = {},
): ControlReceipt {
  return {
    schemaVersion: 1,
    controlId: command.controlId,
    runId: command.runId,
    status,
    ...details,
  };
}
