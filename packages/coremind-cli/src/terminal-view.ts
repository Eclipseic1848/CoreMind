import type { ControlReceipt, CoreMindEvent, ToolCallResultAxes } from "coremind-ai";
import {
  safeArtifactRelativePath,
  summarizeTerminalArguments,
  terminalText,
  terminalTextResult,
} from "./render.js";

export const MAX_TERMINAL_ROWS = 30;
type Lifecycle = Extract<CoreMindEvent, { type: "tool_lifecycle" }>;
type Evidence = Extract<CoreMindEvent, { type: "tool_execution_evidence" }>;

export interface TerminalCallIdentity {
  agent: string;
  stepId?: string;
  callId: string;
}
interface TerminalRowBase {
  id: number;
  epoch: number;
  runId?: string;
}
export type TerminalRow = TerminalRowBase &
  (
    | {
        kind: "text";
        role: "user" | "assistant" | "notice";
        text: string;
        truncated?: boolean;
        agent?: string;
        stepId?: string;
      }
    | {
        kind: "tool";
        call: TerminalCallIdentity;
        tool: string;
        arguments: string;
        phase?: Lifecycle["resolution"]["phase"];
        phaseStatus?: Lifecycle["resolution"]["status"];
        reason?: string;
        result: Partial<ToolCallResultAxes>;
        effect?: "not_started" | "started" | "committed" | "unknown";
        execution?: Evidence["execution"];
        approval?: { approvalId: string; decision?: "allow" | "deny" };
        resultReceived: boolean;
        isError?: boolean;
        observedAtMs: number;
        executingAtMs?: number;
        runEnded?: boolean;
        detached?: boolean;
      }
    | { kind: "control"; receipt: ControlReceipt }
    | {
        kind: "input";
        inputId: string;
        status: "pending" | "claimed" | "completed" | "discarded";
        turnId?: string;
      }
    | {
        kind: "artifact";
        artifactId: string;
        status: "stored" | "blocked";
        sizeBytes: number;
        mediaType: string;
        relativePath?: string;
        call?: TerminalCallIdentity;
      }
    | {
        kind: "approval";
        approvalId: string;
        runId: string;
        tool: string;
        decision?: "allow" | "deny";
      }
  );

export interface TerminalViewState {
  rows: readonly TerminalRow[];
  nextId: number;
  active?: { epoch: number; rootRunId?: string };
}
export type TerminalViewAction =
  | { type: "begin"; epoch: number }
  | { type: "append"; epoch: number; role: "user" | "assistant" | "notice"; text: string }
  | { type: "event"; epoch: number; event: CoreMindEvent; observedAtMs: number; runId?: string }
  | { type: "control"; epoch: number; receipt: ControlReceipt }
  | { type: "end"; epoch: number; runId?: string };

export function createTerminalView(): TerminalViewState {
  return { rows: [], nextId: 0 };
}
type RowContent<T = TerminalRow> = T extends TerminalRow ? Omit<T, "id" | "epoch"> : never;
type ToolRow = Extract<TerminalRow, { kind: "tool" }>;

function validReference(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 4096 &&
    !/\s/u.test(value) &&
    terminalText(value) === value
  );
}
function callIdentity(value: {
  agent?: string;
  stepId?: string;
  callId?: string;
}): TerminalCallIdentity | undefined {
  if (
    !validReference(value.agent) ||
    !validReference(value.callId) ||
    (value.stepId !== undefined && !validReference(value.stepId))
  )
    return undefined;
  if (
    Buffer.byteLength(JSON.stringify([value.agent, value.stepId ?? null, value.callId]), "utf8") >
    4096
  )
    return undefined;
  return {
    agent: value.agent,
    callId: value.callId,
    ...(value.stepId !== undefined ? { stepId: value.stepId } : {}),
  };
}
function sameCall(left: TerminalCallIdentity, right: TerminalCallIdentity): boolean {
  return left.agent === right.agent && left.stepId === right.stepId && left.callId === right.callId;
}
function mergeResult(
  previous: Partial<ToolCallResultAxes>,
  incoming: Partial<ToolCallResultAxes> | undefined,
): Partial<ToolCallResultAxes> {
  const result = { ...previous };
  for (const key of [
    "executionOutcome",
    "effectState",
    "persistenceState",
    "recoveryDisposition",
    "cleanupState",
    "authorizationState",
    "environmentState",
  ] as const) {
    const value = incoming?.[key];
    if (typeof value === "string" && value.length <= 32) Object.assign(result, { [key]: value });
  }
  return result;
}

/** 只折叠展示证据；执行、审批与完整历史仍属于 Runtime。 */
export function foldTerminalView(
  state: TerminalViewState,
  action: TerminalViewAction,
): TerminalViewState {
  let rows = [...state.rows];
  let nextId = state.nextId;
  let active = state.active;
  const epoch = action.epoch;
  const sourceRunId =
    action.type === "event"
      ? validReference(action.runId)
        ? action.runId
        : "runId" in action.event && validReference(action.event.runId)
          ? action.event.runId
          : undefined
      : undefined;
  const append = (row: RowContent) => {
    rows.push({
      ...row,
      id: nextId++,
      epoch,
      ...(sourceRunId && !row.runId ? { runId: sourceRunId } : {}),
    } as TerminalRow);
  };
  const notice = (text: string) =>
    append({ kind: "text", role: "notice", text: terminalText(text) });
  const updateTool = (
    value: { agent?: string; stepId?: string; callId?: string; tool: string },
    update: (row: ToolRow) => ToolRow,
    args?: unknown,
    runId = sourceRunId,
  ) => {
    const call = callIdentity(value);
    if (!call) {
      notice(`未绑定工具事件 · ${terminalText(value.tool, 512)}`);
      return;
    }
    const index = rows.findIndex(
      (row) =>
        row.kind === "tool" &&
        row.epoch === epoch &&
        row.runId === runId &&
        sameCall(row.call, call),
    );
    if (index >= 0) {
      const row = rows[index] as ToolRow;
      if (row.tool !== terminalText(value.tool, 512)) {
        notice("未绑定工具事件：调用身份对应了不同工具");
        return;
      }
      rows[index] = update(row);
    } else {
      const row: ToolRow = {
        id: nextId++,
        epoch,
        ...(runId ? { runId } : {}),
        kind: "tool",
        call,
        tool: terminalText(value.tool, 512),
        arguments: args === undefined ? "" : summarizeTerminalArguments(args),
        result: {},
        resultReceived: false,
        observedAtMs: action.type === "event" ? action.observedAtMs : 0,
        ...(action.type === "event" && action.event.type !== "tool_call" ? { detached: true } : {}),
      };
      rows.push(update(row));
    }
  };

  if (action.type === "begin") active = { epoch };
  else if (action.type === "append") {
    const { text, truncated } = terminalTextResult(action.text);
    append({
      kind: "text",
      role: action.role,
      text,
      truncated,
    });
  } else if (action.type === "end") {
    const rootRunId = validReference(action.runId)
      ? action.runId
      : active?.epoch === epoch
        ? active.rootRunId
        : undefined;
    if (active?.epoch === epoch && rootRunId) active = { ...active, rootRunId };
    rows = rows.map((row) => {
      if (row.epoch !== epoch) return row;
      if (row.kind === "tool") return { ...row, runEnded: true };
      if (row.kind === "text" && row.role === "user" && !row.runId && rootRunId)
        return { ...row, runId: rootRunId };
      return row;
    });
  } else if (action.type === "control") {
    const receipt = action.receipt;
    if (!validReference(receipt.controlId) || !validReference(receipt.runId))
      notice("未绑定控制回执：身份超出显示上限");
    else {
      const safe: ControlReceipt = {
        schemaVersion: 1,
        controlId: receipt.controlId,
        runId: receipt.runId,
        status: receipt.status,
        ...(receipt.duplicateOf ? { duplicateOf: receipt.duplicateOf } : {}),
        ...(receipt.reason ? { reason: terminalText(receipt.reason, 512) } : {}),
      };
      const index = rows.findIndex(
        (row) =>
          row.kind === "control" &&
          row.epoch === epoch &&
          row.receipt.runId === receipt.runId &&
          row.receipt.controlId === receipt.controlId,
      );
      if (index >= 0) rows[index] = { ...rows[index], receipt: safe } as TerminalRow;
      else append({ kind: "control", receipt: safe, runId: receipt.runId });
    }
  } else {
    const event = action.event;
    switch (event.type) {
      case "agent_start":
        if (
          !validReference(event.agent) ||
          (event.stepId !== undefined && !validReference(event.stepId))
        ) {
          notice("未绑定正文来源：身份超出显示上限");
          break;
        }
        append({
          kind: "text",
          role: "assistant",
          text: "",
          agent: event.agent,
          ...(event.stepId ? { stepId: event.stepId } : {}),
        });
        break;
      case "text_delta": {
        if (!event.delta) break;
        if (
          !validReference(event.agent) ||
          (event.stepId !== undefined && !validReference(event.stepId))
        ) {
          notice(`未绑定正文来源 · ${event.delta}`);
          break;
        }
        let index = -1;
        for (let current = rows.length - 1; current >= 0; current--) {
          const row = rows[current]!;
          if (
            row.kind === "text" &&
            row.role === "assistant" &&
            row.epoch === epoch &&
            row.runId === sourceRunId &&
            row.agent === event.agent &&
            row.stepId === event.stepId
          ) {
            index = current;
            break;
          }
        }
        const previous = index < 0 ? undefined : rows[index];
        if (previous?.kind === "text" && previous.truncated) break;
        const combined = (previous?.kind === "text" ? previous.text : "") + event.delta;
        const { text, truncated } = terminalTextResult(combined);
        const value = {
          kind: "text" as const,
          role: "assistant" as const,
          text,
          truncated,
          agent: event.agent,
          ...(event.stepId ? { stepId: event.stepId } : {}),
        };
        if (index >= 0) rows[index] = { ...rows[index], ...value } as TerminalRow;
        else append(value);
        break;
      }
      case "tool_call":
        updateTool(
          event,
          (row) => ({ ...row, arguments: summarizeTerminalArguments(event.args) }),
          event.args,
        );
        break;
      case "tool_result":
        updateTool(event, (row) => ({ ...row, resultReceived: true, isError: event.isError }));
        break;
      case "tool_execution_evidence":
        updateTool(event, (row) => ({
          ...row,
          execution: { durationMs: event.execution.durationMs, exitCode: event.execution.exitCode },
        }));
        break;
      case "tool_lifecycle":
        updateTool(event, (row) => ({
          ...row,
          phase: event.resolution.phase,
          phaseStatus: event.resolution.status,
          ...("reason" in event.resolution
            ? { reason: terminalText(event.resolution.reason, 512) }
            : {}),
          result: mergeResult(row.result, event.resolution.result),
          ...(event.resolution.phase === "executing" &&
          event.resolution.status === "completed" &&
          row.executingAtMs === undefined
            ? { executingAtMs: action.observedAtMs }
            : {}),
        }));
        break;
      case "effect_receipt":
        updateTool(event, (row) => ({ ...row, effect: event.status }));
        break;
      case "approval_required": {
        if (!validReference(event.approvalId) || !validReference(event.runId)) {
          notice("未绑定审批：身份超出显示上限");
          break;
        }
        if (callIdentity(event))
          updateTool(
            event,
            (row) => ({
              ...row,
              runId: event.runId,
              approval: { approvalId: event.approvalId },
            }),
            undefined,
            event.runId,
          );
        else
          append({
            kind: "approval",
            approvalId: event.approvalId,
            runId: event.runId,
            tool: terminalText(event.tool, 512),
          });
        break;
      }
      case "approval_resolved": {
        if (!validReference(event.approvalId) || !validReference(event.runId)) {
          notice("未绑定审批结果：身份超出显示上限");
          break;
        }
        const index = rows.findIndex(
          (row) =>
            row.epoch === epoch &&
            row.runId === event.runId &&
            ((row.kind === "tool" && row.approval?.approvalId === event.approvalId) ||
              (row.kind === "approval" && row.approvalId === event.approvalId)),
        );
        const row = rows[index];
        if (row?.kind === "tool")
          rows[index] = {
            ...row,
            approval: { approvalId: event.approvalId, decision: event.decision },
          };
        else if (row?.kind === "approval") rows[index] = { ...row, decision: event.decision };
        else
          append({
            kind: "approval",
            runId: event.runId,
            approvalId: event.approvalId,
            tool: "未绑定工具",
            decision: event.decision,
          });
        break;
      }
      case "artifact_created": {
        const source = event as typeof event & { agent?: string; stepId?: string };
        const call = callIdentity(source);
        if (!validReference(event.artifactId)) {
          notice("未绑定 Artifact：身份超出显示上限");
          break;
        }
        const relativePath =
          event.status === "stored" ? safeArtifactRelativePath(event.relativePath) : undefined;
        append({
          kind: "artifact",
          artifactId: event.artifactId,
          status: event.status,
          sizeBytes: event.sizeBytes,
          mediaType: terminalText(event.mediaType, 512),
          ...(relativePath ? { relativePath } : {}),
          ...(call ? { call } : {}),
        });
        break;
      }
      case "input_receipt":
      case "input_claimed":
      case "input_completed":
      case "input_discarded": {
        if (!validReference(event.inputId)) {
          notice("未绑定输入回执：身份超出显示上限");
          break;
        }
        const index = rows.findIndex(
          (row) =>
            row.kind === "input" &&
            row.epoch === epoch &&
            row.runId === sourceRunId &&
            row.inputId === event.inputId,
        );
        const value = {
          kind: "input" as const,
          inputId: event.inputId,
          status: event.status,
          ...(event.type === "input_claimed" && validReference(event.turnId)
            ? { turnId: event.turnId }
            : {}),
        };
        if (index >= 0) rows[index] = { ...rows[index], ...value } as TerminalRow;
        else append(value);
        break;
      }
      case "context_prefix":
      case "provider_request":
        if (event.toolDiscovery)
          notice(
            `${event.type === "context_prefix" ? "正在准备" : "本次使用"}第 ${event.toolDiscovery.generation} 代 ${event.toolDiscovery.toolCount} 项工具声明 · ${event.agent} · ${event.toolDiscovery.selectionFingerprint}`,
          );
        break;
      case "error":
        notice(`错误：${event.message}`);
        break;
      default:
        break;
    }
  }
  return { rows: rows.slice(-MAX_TERMINAL_ROWS), nextId, ...(active ? { active } : {}) };
}
