import { isRetryableDependencyAssistantError } from "./dependency-adapter.js";
import {
  CoreMindError,
  ERROR_CODES,
  type ErrorCode,
  isErrorCode,
  normalizeExternalErrorCode,
} from "./errors.js";
import { redactSensitiveText, redactSensitiveValue } from "./trace.js";

const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

export interface ExecutionErrorClassification {
  code: ErrorCode;
  retryClass: "human" | "transient" | "fatal";
  message: string;
  audit?: { originalCode: string };
}

/** 把 Runtime、Provider、Tool 与 Adapter 异常收敛到唯一 Error Contract。 */
export function classifyExecutionError(error: unknown): ExecutionErrorClassification {
  const values = errorChain(error);

  for (const value of values) {
    const code = stringField(value, "code");
    if (code && isErrorCode(code)) return knownClassification(code, value);
  }
  for (const value of values) {
    if (isAssistantFailure(value)) {
      return isRetryableDependencyAssistantError(value)
        ? knownClassification("provider_transient", value)
        : unclassifiedClassification(value);
    }
  }
  for (const value of values) {
    const code = stringField(value, "code");
    if (code && TRANSIENT_SYSTEM_CODES.has(code)) {
      return knownClassification("network_error", value);
    }
    const status = numericField(value, "status") ?? numericField(value, "statusCode");
    if (status === 408) return knownClassification("provider_timeout", value);
    if (status === 429) return knownClassification("rate_limit", value);
    if (status !== undefined && status >= 500 && status <= 599) {
      return knownClassification("provider_unavailable", value);
    }
  }
  return unclassifiedClassification(values[0] ?? error);
}

/** 已登记错误保持原语义；未知外部错误只公开 unclassified_error。 */
export function normalizeExecutionError(error: unknown): CoreMindError<ErrorCode> {
  if (error instanceof CoreMindError && isErrorCode(error.code)) {
    return error as CoreMindError<ErrorCode>;
  }
  const classification = classifyExecutionError(error);
  return new CoreMindError(classification.code, classification.message, classification.audit);
}

function knownClassification(code: ErrorCode, value: unknown): ExecutionErrorClassification {
  return {
    code,
    retryClass: ERROR_CODES[code].retryClass,
    message: safeKnownMessage(value, code),
  };
}

function unclassifiedClassification(value: unknown): ExecutionErrorClassification {
  const originalCode = auditValue(value);
  const normalized = normalizeExternalErrorCode(originalCode);
  return {
    code: normalized.code,
    retryClass: ERROR_CODES[normalized.code].retryClass,
    message: "外部执行返回未分类错误，需人工审计后继续",
    ...(normalized.audit ? { audit: normalized.audit } : {}),
  };
}

function safeKnownMessage(value: unknown, code: ErrorCode): string {
  if (value instanceof Error && value.message)
    return redactSensitiveText(value.message).slice(0, 512);
  const message = stringField(value, "errorMessage") ?? stringField(value, "message");
  return message ? redactSensitiveText(message).slice(0, 512) : `外部执行失败：${code}`;
}

function auditValue(value: unknown): string {
  const code = stringField(value, "code");
  if (code) return nonEmptyAudit(redactSensitiveText(code));
  const assistantMessage = stringField(value, "errorMessage");
  if (assistantMessage) return nonEmptyAudit(redactSensitiveText(assistantMessage));
  if (value instanceof Error) {
    return nonEmptyAudit(redactSensitiveText(`${value.name}: ${value.message}`));
  }
  if (typeof value === "string") return nonEmptyAudit(redactSensitiveText(value));
  try {
    return nonEmptyAudit(redactSensitiveText(JSON.stringify(redactSensitiveValue(value))));
  } catch {
    return "<无法序列化的外部错误>";
  }
}

function nonEmptyAudit(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 512) : "<空外部错误>";
}

function isAssistantFailure(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).role === "assistant" &&
    (value as Record<string, unknown>).stopReason === "error" &&
    typeof (value as Record<string, unknown>).errorMessage === "string"
  );
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = objectField(current, "cause");
  }
  return values;
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

function numericField(value: unknown, key: string): number | undefined {
  const field = objectField(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
