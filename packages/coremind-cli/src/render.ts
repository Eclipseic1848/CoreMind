import { stripVTControlCharacters } from "node:util";
import type { ControlReceipt, LoopPhase } from "coremind-ai";
import { redactSensitiveText, redactSensitiveValue } from "coremind-ai/internal";
import { terminalInputCursor } from "./terminal-input.js";
import type { TerminalRow } from "./terminal-view.js";

/** 极简 ANSI 渲染（避免引入 TUI 依赖） */

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";

/** 终端是否支持颜色 */
function colorEnabled(): boolean {
  return process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
}

function paint(code: string, text: string): string {
  return colorEnabled() ? `${code}${text}${RESET}` : text;
}

export const cyan = (s: string) => paint(CYAN, s);
export const green = (s: string) => paint(GREEN, s);
export const yellow = (s: string) => paint(YELLOW, s);
export const red = (s: string) => paint(RED, s);
export const dim = (s: string) => paint(DIM, s);

/** 步骤行：─ 收集 (collector) */
export function stepLine(stepId: string, kind: string): string {
  return dim(`── [${stepId}] ${kind}`);
}

/** Loop 状态行：↻ 修复中 · 第 2 轮 · 已修复 1 次 */
export function loopStateLine(phase: LoopPhase, iteration: number, repairs: number): string {
  return dim(`↻ ${loopStateText(phase, iteration, repairs)}`);
}

/** 不带 ANSI 的 Loop 状态文本，供 ink TUI 使用。 */
export function loopStateText(phase: LoopPhase, iteration: number, repairs: number): string {
  const labels: Record<LoopPhase, string> = {
    idle: "等待开始",
    planning: "规划中",
    executing: "执行中",
    verifying: "验证中",
    repairing: "修复中",
    paused: "已暂停",
    succeeded: "验证通过",
    failed: "验证失败",
    aborted: "已中止",
    timeout: "已超时",
    budget_exceeded: "预算耗尽",
  };
  return `${labels[phase]} · 第 ${iteration} 轮 · 已修复 ${repairs} 次`;
}

/** 工具调用行：  ⚙ read notes.txt */
export function toolLine(tool: string, args: unknown): string {
  const argText = summarizeTerminalArguments(args);
  return dim(`  ⚙ ${terminalText(tool)}${argText ? ` ${argText}` : ""}`);
}

/** 工具结果行：  ✓ 成功 / ✗ 失败 */
export function toolResultLine(isError: boolean): string {
  return isError ? red("  ✗ 执行失败") : dim("  ✓ 完成");
}

/** 错误行 */
export function errorLine(message: string): string {
  return red(`✗ ${terminalText(message)}`);
}

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
// biome-ignore lint/suspicious/noControlCharactersInRegex: 显式移除外来终端控制字符，保留正文换行。
const terminalControls = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu;

/** 先移除可重组标签的控制码再完整脱敏；省略标志也计入显示上限。 */
export function terminalText(text: string, maxGraphemes = 16_384, maxBytes = 65_536): string {
  return terminalTextResult(text, maxGraphemes, maxBytes).text;
}

/** 先完整净化和脱敏，再显示光标；安全文本改变时不用原 offset 拆分凭据。 */
export function formatTerminalInput(text: string, offset?: number): string {
  const safe = terminalText(text);
  const cursor = terminalInputCursor(text, offset);
  if (safe === text) return `${text.slice(0, cursor)}▏${text.slice(cursor)}`;
  let position = 0;
  let total = 0;
  for (const part of graphemes.segment(text)) {
    if (part.index < cursor) position++;
    total++;
  }
  return `${safe} [光标 ${position}/${total}]`;
}

/** 只有实际超过显示上限才标记截断，不根据正文末尾字符猜测。 */
export function terminalTextResult(
  text: string,
  maxGraphemes = 16_384,
  maxBytes = 65_536,
): { text: string; truncated: boolean } {
  const clean = redactSensitiveText(
    stripVTControlCharacters(text).replace(terminalControls, "").replace(/\t/gu, " "),
  );
  const parts: string[] = [];
  let bytes = 0;
  for (const { segment } of graphemes.segment(clean)) {
    const size = Buffer.byteLength(segment, "utf8");
    if (parts.length >= maxGraphemes || bytes + size > maxBytes) {
      while (parts.length > 0 && (parts.length >= maxGraphemes || bytes + 3 > maxBytes))
        bytes -= Buffer.byteLength(parts.pop()!, "utf8");
      if (maxGraphemes > 0 && bytes + 3 <= maxBytes) parts.push("…");
      return { text: parts.join(""), truncated: true };
    }
    parts.push(segment);
    bytes += size;
  }
  return { text: parts.join(""), truncated: false };
}

/** 结构投影有界，保留的字符串先完整脱敏，避免截断凭据后失去识别上下文。 */
export function summarizeTerminalArguments(args: unknown): string {
  const seen = new WeakSet<object>();
  const project = (value: unknown, depth = 0): unknown => {
    if (value === null || typeof value !== "object")
      return typeof value === "bigint" ? String(value) : value;
    if (depth >= 4) return "<嵌套已省略>";
    if (seen.has(value)) return "<循环引用已省略>";
    seen.add(value);
    if (Array.isArray(value)) {
      const result = [
        ...value.slice(0, 8).map((item) => project(item, depth + 1)),
        ...(value.length > 8 ? ["<更多项已省略>"] : []),
      ];
      seen.delete(value);
      return result;
    }
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count++ >= 8) {
        result["…"] = "<更多字段已省略>";
        break;
      }
      result[key] = project((value as Record<string, unknown>)[key], depth + 1);
    }
    seen.delete(value);
    return result;
  };
  try {
    return terminalText(JSON.stringify(redactSensitiveValue(project(args))) ?? "", 512);
  } catch {
    return "<参数无法显示，已省略>";
  }
}

export function formatControlReceipt(receipt: ControlReceipt): string {
  const labels = {
    accepted: "已接收，等待应用",
    applied: "已应用到队列，等待模型认领",
    rejected: "已拒绝",
    duplicate: "重复请求",
    conflict: "身份内容冲突",
  };
  return terminalText(
    `控制 ${receipt.controlId} · Run ${receipt.runId} · ${receipt.status} · ${labels[receipt.status]}${receipt.duplicateOf ? ` · 原状态 ${receipt.duplicateOf}` : ""}${receipt.reason ? `：${receipt.reason}` : ""}`,
  );
}

export function formatInputReceipt(input: {
  inputId: string;
  status: string;
  turnId?: string;
}): string {
  const labels: Record<string, string> = {
    pending: "待认领",
    claimed: "已认领",
    completed: "对应活动已结束",
    discarded: "已丢弃",
  };
  return terminalText(
    `输入 ${input.inputId} · ${input.status}${input.turnId ? ` · Turn ${input.turnId}` : ""} · ${labels[input.status] ?? "未记录状态"}`,
  );
}

/** 仅返回未经净化改变的安全相对引用；本函数不访问文件。 */
export function safeArtifactRelativePath(value: string | undefined): string | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 路径禁止任何 C0 字符，避免换行伪造引用。
  if (!value || /[\x00-\x1f]/u.test(value) || value !== terminalText(value)) return undefined;
  const normalized = value.replace(/\\/gu, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  )
    return undefined;
  return value;
}

export function formatArtifactReference(artifact: {
  artifactId: string;
  status: "stored" | "blocked";
  sizeBytes: number;
  mediaType: string;
  relativePath?: string;
}): string {
  const location =
    artifact.status === "blocked"
      ? "已阻止保存，不能打开"
      : (safeArtifactRelativePath(artifact.relativePath) ?? "未提供安全相对路径");
  return terminalText(
    `Artifact ${artifact.artifactId} · ${artifact.status} · ${artifact.sizeBytes} bytes · ${location}`,
  );
}

export function formatTerminalRow(row: TerminalRow, nowMs?: number): string {
  if (row.kind === "text") return row.text;
  if (row.kind === "control") return formatControlReceipt(row.receipt);
  if (row.kind === "input") return formatInputReceipt(row);
  if (row.kind === "approval")
    return terminalText(
      `审批 ${row.approvalId} · Run ${row.runId} · ${row.tool} · ${row.decision === "allow" ? "已批准" : row.decision === "deny" ? "已拒绝" : "等待审批"} · 未绑定调用`,
    );
  const reference = (call: { agent: string; stepId?: string; callId: string }) =>
    `${call.agent}${call.stepId ? `/${call.stepId}` : ""} · Call ${call.callId} · Run ${row.runId ?? "未绑定"}`;
  if (row.kind === "artifact")
    return `${formatArtifactReference(row)} · ${row.call ? terminalText(reference(row.call)) : "未绑定调用来源"}`;
  const outcomes = {
    not_invoked: "未调用",
    returned: "已返回",
    threw: "执行抛错",
    timed_out: "执行超时",
    aborted: "执行已中止",
  };
  const effects = {
    not_started: "未开始",
    started: "已开始",
    committed: "已提交",
    unknown: "未知",
  };
  const status = row.result.executionOutcome
    ? outcomes[row.result.executionOutcome]
    : row.resultReceived
      ? row.isError
        ? "执行失败"
        : "结果已返回"
      : row.runEnded
        ? "未收到结果"
        : row.approval && !row.approval.decision
          ? "等待审批"
          : row.phase === "executing"
            ? "执行中"
            : "已登记，等待准入";
  const parts = [`⚙ ${row.tool} · ${reference(row.call)}`, status];
  if (row.detached) parts.push("原始调用不在当前窗口");
  if (row.runEnded && !row.resultReceived && status !== "未收到结果") parts.push("未收到结果");
  const effect = row.effect ?? row.result.effectState;
  if (effect) parts.push(`效果${effects[effect]}`);
  if (row.approval?.decision) parts.push(row.approval.decision === "allow" ? "已批准" : "已拒绝");
  if (row.result.authorizationState === "denied") parts.push("准入已拒绝");
  if (row.result.persistenceState) parts.push(`持久状态 ${row.result.persistenceState}`);
  if (row.result.cleanupState) parts.push(`清理状态 ${row.result.cleanupState}`);
  parts.push(
    row.execution
      ? `执行耗时 ${row.execution.durationMs}ms${row.execution.exitCode !== null ? ` · 退出码 ${row.execution.exitCode}` : ""}`
      : "执行耗时未记录",
  );
  if (
    nowMs !== undefined &&
    Number.isFinite(nowMs) &&
    row.executingAtMs === undefined &&
    !row.resultReceived &&
    !row.runEnded
  )
    parts.push(`观察等待 ${Math.max(0, Math.floor(nowMs - row.observedAtMs))}ms`);
  if (row.reason) parts.push(row.reason);
  if (row.arguments) parts.push(row.arguments);
  if (row.tool === "load_skill" && row.resultReceived && row.isError === false)
    parts.push("技能说明已交付，权限未改变");
  if (row.tool === "discover_tools" && row.resultReceived && row.isError === false)
    parts.push("查找已完成，声明尚待实际请求确认");
  return terminalText(parts.join(" · "));
}
