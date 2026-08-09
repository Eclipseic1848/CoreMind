import { randomUUID } from "node:crypto";
import type { CoreMindEvent } from "./events.js";

/** 可持久化、可跨 SDK 对齐的一条运行轨迹。 */
export interface CoreMindTraceEvent {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string;
  event: CoreMindEvent;
}

export class TraceRecorder {
  private sequence: number;
  readonly entries: CoreMindTraceEvent[];

  constructor(
    readonly runId: string,
    private readonly forward?: (entry: CoreMindTraceEvent) => void,
    initialEntries: CoreMindTraceEvent[] = [],
  ) {
    this.entries = [...initialEntries];
    this.sequence = initialEntries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0);
  }

  record(event: CoreMindEvent): CoreMindTraceEvent {
    const entry: CoreMindTraceEvent = {
      eventId: randomUUID(),
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      event: sanitizeTraceEvent(event),
    };
    this.entries.push(entry);
    this.forward?.(entry);
    return entry;
  }
}

/** Trace 与 RunState 只能保存审计所需摘要，不能持久化凭据、正文或命令原文。 */
export function sanitizeTraceEvent(event: CoreMindEvent): CoreMindEvent {
  if (event.type === "tool_call") {
    return { ...event, args: redactValue(event.args) };
  }
  if (event.type === "approval_required") {
    return {
      ...event,
      args: redactValue(event.args),
      effect: {
        ...event.effect,
        urls: event.effect.urls.map(redactUrl),
      },
    };
  }
  return event;
}

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (isSecretKey(key)) return "<已隐藏>";
  if (typeof value === "string") {
    if (isBodyKey(key)) return `<${key || "正文"} 已隐藏：${value.length} 字符>`;
    if (isCommandKey(key)) return redactSensitiveText(value);
    if (/^urls?$/iu.test(key)) return redactUrl(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key, seen));
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "<循环引用已省略>";
    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        redactValue(item, childKey, seen),
      ]),
    );
    seen.delete(value);
    return redacted;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key|credential|client[_-]?secret/iu.test(
    key,
  );
}

function isBodyKey(key: string): boolean {
  return /^(?:body|content|patch|text)$/iu.test(key);
}

function isCommandKey(key: string): boolean {
  return /^(?:command|script|sql)$/iu.test(key);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"']+/giu, (url) => redactUrl(url))
    .replace(
      /((?:--?(?:api[_-]?key|token|secret|password|authorization)|(?:api[_-]?key|token|secret|password|authorization))\s*(?:=|\s)\s*)[^\s"']+/giu,
      "$1hidden",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1hidden");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "hidden";
    if (url.password) url.password = "hidden";
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretKey(key)) url.searchParams.set(key, "hidden");
    }
    return url.toString();
  } catch {
    return value;
  }
}
