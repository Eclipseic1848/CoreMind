import type { LoopPhase } from "coremind-ai";

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
  const argText = summarizeArgs(args);
  return dim(`  ⚙ ${tool}${argText ? ` ${argText}` : ""}`);
}

/** 工具结果行：  ✓ 成功 / ✗ 失败 */
export function toolResultLine(isError: boolean): string {
  return isError ? red("  ✗ 执行失败") : dim("  ✓ 完成");
}

/** 错误行 */
export function errorLine(message: string): string {
  return red(`✗ ${message}`);
}

/** 参数摘要（截断到 60 字符） */
function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(" ");
  return entries.length > 60 ? `${entries.slice(0, 57)}...` : entries;
}
