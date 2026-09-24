import { randomUUID } from "node:crypto";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
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
  private readonly pendingText = new Map<string, Extract<CoreMindEvent, { type: "text_delta" }>>();
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
    const scope = `${"agent" in event ? (event.agent ?? "") : ""}\0${"stepId" in event ? (event.stepId ?? "") : ""}`;
    if (event.type === "text_delta") {
      const text = (this.pendingText.get(scope)?.delta ?? "") + event.delta;
      // 未闭合凭据不能提前外传；限制单个未闭合片段，超限显式失败关闭。
      if (text.length > 65_536)
        throw new CoreMindError("redaction_failed", "Trace 未闭合文本超过安全缓冲上限");
      const boundaries = textBoundaries(text);
      let safe = "";
      let pending = text;
      if (
        boundaries.length > 0 &&
        !/-----BEGIN [\s\S]*$/u.test(text) &&
        !/\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:[^\r\n]*$/iu.test(text)
      ) {
        const end = boundaries.at(-1)!;
        const complete = redactSensitiveText(text.slice(0, end));
        const safeBoundaries = textBoundaries(complete);
        // 仅在引号外截断，并保留凭据标签上下文及未完成值。
        const split = safeBoundaries.length > 3 ? safeBoundaries[safeBoundaries.length - 4]! : 0;
        safe = complete.slice(0, split);
        pending = complete.slice(split) + text.slice(end);
      }
      this.pendingText.set(scope, { ...event, delta: pending });
      return this.append({ ...event, delta: safe });
    }
    if (event.type === "turn_end" || event.type === "agent_end" || event.type === "step_output") {
      const pending = this.pendingText.get(scope);
      if (pending) {
        this.pendingText.delete(scope);
        if (pending.delta) this.append({ ...pending, delta: redactSensitiveText(pending.delta) });
      }
    }
    return this.append(event);
  }

  private append(event: CoreMindEvent): CoreMindTraceEvent {
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

/** 参数正文仅保留摘要；恢复所需事件正文保留结构并移除凭据。 */
export function sanitizeTraceEvent(event: CoreMindEvent): CoreMindEvent {
  if (event.type === "tool_call") {
    return {
      ...event,
      args: redactSensitiveValue(event.args),
      argumentsFingerprint: fingerprintEffectReceiptValue(event.args),
    };
  }
  if (event.type === "approval_required") {
    return {
      ...event,
      args: redactSensitiveValue(event.args),
      argumentsFingerprint: fingerprintEffectReceiptValue(event.args),
      effect: {
        ...event.effect,
        urls: event.effect.urls.map(redactUrl),
      },
    };
  }
  return redactSensitiveValue(event, { redactBodies: false }) as CoreMindEvent;
}

/** 为 Trace 或无凭据能力的扩展创建递归脱敏副本。 */
export function redactSensitiveValue(
  value: unknown,
  options: { redactBodies?: boolean } = {},
  key = "",
  seen = new WeakSet<object>(),
): unknown {
  if (
    isSecretKey(key) &&
    key !== "authorizationState" &&
    key !== "credentialIsolation" &&
    (options.redactBodies !== false || typeof value === "string")
  )
    return "<已隐藏>";
  if (typeof value === "string") {
    if (options.redactBodies !== false && isBodyKey(key)) {
      return `<${key || "正文"} 已隐藏：${value.length} 字符>`;
    }
    if (isCommandKey(key)) return redactSensitiveText(value);
    if (/^(?:urls?|url|uri|endpoint|base[_-]?url)$/iu.test(key)) {
      return redactUrl(value);
    }
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveValue(item, options, key, seen));
  }
  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return "<循环引用已省略>";
    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([childKey, item]) => [
        childKey,
        redactSensitiveValue(item, options, childKey, seen),
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

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/gu,
      "private-key-hidden",
    )
    .replace(/https?:\/\/[^\s"']+/giu, (url) => redactUrl(url))
    .replace(
      /(\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)[ \t]*:)[ \t]*[^ \t\r\n][^\r\n]*/giu,
      "$1 hidden",
    )
    .replace(
      /((?:["']?(?:api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key|credential|client[_-]?secret)["']?\s*[:=]\s*|--?(?:api[_-]?key|token|secret|password|authorization)\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;{}[\]]+)/giu,
      "$1hidden",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1hidden")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/gu,
      "credential-hidden",
    );
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    let sensitive = Boolean(url.username || url.password);
    if (url.username) url.username = "hidden";
    if (url.password) url.password = "hidden";
    for (const key of [...url.searchParams.keys()]) {
      if (isSecretKey(key)) {
        sensitive = true;
        url.searchParams.set(key, "hidden");
      }
    }
    return sensitive ? url.toString() : value;
  } catch {
    return value;
  }
}

/** 反斜杠转义与引号内空白不能成为可外传的切分点。 */
function textBoundaries(value: string): number[] {
  const boundaries: number[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/u.test(char) && (index === value.length - 1 || !/\s/u.test(value[index + 1]!))) {
      boundaries.push(index + 1);
    }
  }
  return boundaries;
}
