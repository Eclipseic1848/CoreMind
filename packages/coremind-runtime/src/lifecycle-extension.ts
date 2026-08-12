// biome-ignore-all lint/suspicious/noConfusingVoidType: 生命周期处理器需要同时支持异步无返回值与显式决策。
export const LIFECYCLE_EVENTS = [
  "before-model",
  "before-tool",
  "after-tool",
  "run-finished",
] as const;

export type LifecycleEventType = (typeof LIFECYCLE_EVENTS)[number];
export type ExtensionFileCapability = "none" | "read" | "write";

export interface LifecycleExtensionCapabilities {
  files: ExtensionFileCapability;
  process: boolean;
  network: boolean;
  credentials: boolean;
  ui: boolean;
}

export interface LifecycleExtensionEvent {
  type: LifecycleEventType;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface LifecycleExtensionDecision {
  /** 扩展只能附加拒绝，不能授予权限或改写人工审批。 */
  deny?: { reason: string };
}

export type LifecycleExtensionHandler = (
  event: LifecycleExtensionEvent,
) => void | LifecycleExtensionDecision | Promise<void | LifecycleExtensionDecision>;

export interface LifecycleExtension {
  id: string;
  version: string;
  capabilities: LifecycleExtensionCapabilities;
  handlers: Partial<Record<LifecycleEventType, LifecycleExtensionHandler>>;
}

export interface LifecycleExtensionPolicy {
  extensions: LifecycleExtension[];
  /** 显式信任清单；CoreMind 不扫描或自动加载项目本地扩展。 */
  trustedIds: string[];
  grants: Record<string, LifecycleExtensionCapabilities>;
  timeoutMs?: number;
}

export type LifecycleExtensionReceiptStatus = "succeeded" | "failed" | "timed_out";

export interface LifecycleExtensionReceipt {
  extensionId: string;
  extensionVersion: string;
  event: LifecycleEventType;
  status: LifecycleExtensionReceiptStatus;
  durationMs: number;
  error?: string;
  denied?: boolean;
}

export interface LifecycleDispatchResult {
  receipts: LifecycleExtensionReceipt[];
  denied?: { extensionId: string; reason: string };
}

export type LifecycleExtensionErrorCode =
  | "extension_invalid"
  | "extension_duplicate"
  | "extension_not_trusted"
  | "extension_capability_denied";

export class LifecycleExtensionError extends Error {
  constructor(
    readonly code: LifecycleExtensionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LifecycleExtensionError";
  }
}

/** 定义一个进程内扩展。显式注册代表代码信任，但能力仍需宿主逐项授权。 */
export function defineLifecycleExtension(extension: LifecycleExtension): LifecycleExtension {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(extension.id)) {
    throw new LifecycleExtensionError("extension_invalid", `扩展 id 无效：${extension.id}`);
  }
  if (!extension.version.trim()) {
    throw new LifecycleExtensionError("extension_invalid", `扩展 ${extension.id} 缺少版本`);
  }
  validateCapabilities(extension.id, extension.capabilities);
  for (const event of Object.keys(extension.handlers)) {
    if (!LIFECYCLE_EVENTS.includes(event as LifecycleEventType)) {
      throw new LifecycleExtensionError(
        "extension_invalid",
        `扩展 ${extension.id} 声明了未知生命周期：${event}`,
      );
    }
  }
  return Object.freeze({
    ...extension,
    capabilities: Object.freeze({ ...extension.capabilities }),
    handlers: Object.freeze({ ...extension.handlers }),
  });
}

export class LifecycleExtensionHost {
  private readonly extensions: LifecycleExtension[];
  private readonly timeoutMs: number;

  constructor(policy: LifecycleExtensionPolicy) {
    this.timeoutMs = policy.timeoutMs ?? 1_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new LifecycleExtensionError("extension_invalid", "扩展超时必须是正整数毫秒");
    }
    const seen = new Set<string>();
    const trusted = new Set(policy.trustedIds);
    for (const extension of policy.extensions) {
      if (seen.has(extension.id)) {
        throw new LifecycleExtensionError("extension_duplicate", `扩展 id 重复：${extension.id}`);
      }
      seen.add(extension.id);
      if (!trusted.has(extension.id)) {
        throw new LifecycleExtensionError(
          "extension_not_trusted",
          `扩展 ${extension.id} 未列入显式信任清单`,
        );
      }
      const grant = policy.grants[extension.id];
      if (!grant || !capabilitiesAllowed(extension.capabilities, grant)) {
        throw new LifecycleExtensionError(
          "extension_capability_denied",
          `扩展 ${extension.id} 请求的能力未被完整授权`,
        );
      }
    }
    this.extensions = [...policy.extensions].sort((left, right) =>
      left.id.localeCompare(right.id, "en"),
    );
  }

  async dispatch(
    type: LifecycleEventType,
    payload: Record<string, unknown>,
  ): Promise<LifecycleDispatchResult> {
    const receipts: LifecycleExtensionReceipt[] = [];
    let denied: LifecycleDispatchResult["denied"];
    for (const extension of this.extensions) {
      const handler = extension.handlers[type];
      if (!handler) continue;
      const event = deepFreeze({
        type,
        occurredAt: new Date().toISOString(),
        payload: clonePayload(payload, extension.capabilities.credentials),
      }) as LifecycleExtensionEvent;
      const startedAt = performance.now();
      try {
        const decision = await withTimeout(Promise.resolve(handler(event)), this.timeoutMs);
        const extensionDenied =
          type === "before-tool" && decision?.deny?.reason.trim()
            ? decision.deny.reason.trim()
            : undefined;
        if (extensionDenied && !denied) {
          denied = { extensionId: extension.id, reason: extensionDenied };
        }
        receipts.push({
          extensionId: extension.id,
          extensionVersion: extension.version,
          event: type,
          status: "succeeded",
          durationMs: performance.now() - startedAt,
          ...(extensionDenied ? { denied: true } : {}),
        });
      } catch (error) {
        const timedOut = error instanceof ExtensionTimeoutError;
        receipts.push({
          extensionId: extension.id,
          extensionVersion: extension.version,
          event: type,
          status: timedOut ? "timed_out" : "failed",
          durationMs: performance.now() - startedAt,
          error: timedOut ? `超过 ${this.timeoutMs}ms` : safeError(error),
        });
      }
    }
    return { receipts, ...(denied ? { denied } : {}) };
  }
}

export function createTraceExporterExtension(options: {
  id: string;
  exporter: (event: LifecycleExtensionEvent) => void | Promise<void>;
}): LifecycleExtension {
  const handler: LifecycleExtensionHandler = (event) => options.exporter(event);
  return defineLifecycleExtension({
    id: options.id,
    version: "1.0.0",
    capabilities: noCapabilities(),
    handlers: Object.fromEntries(LIFECYCLE_EVENTS.map((event) => [event, handler])),
  });
}

export function createDenyPolicyExtension(options: {
  id: string;
  deniedTools: string[];
}): LifecycleExtension {
  const deniedTools = new Set(options.deniedTools);
  return defineLifecycleExtension({
    id: options.id,
    version: "1.0.0",
    capabilities: noCapabilities(),
    handlers: {
      "before-tool": ({ payload }) => {
        const tool = typeof payload.tool === "string" ? payload.tool : "";
        return deniedTools.has(tool)
          ? { deny: { reason: `扩展策略 ${options.id} 拒绝工具 ${tool}` } }
          : undefined;
      },
    },
  });
}

function noCapabilities(): LifecycleExtensionCapabilities {
  return { files: "none", process: false, network: false, credentials: false, ui: false };
}

function validateCapabilities(id: string, capabilities: LifecycleExtensionCapabilities): void {
  if (
    !capabilities ||
    !(["none", "read", "write"] as const).includes(capabilities.files) ||
    [capabilities.process, capabilities.network, capabilities.credentials, capabilities.ui].some(
      (value) => typeof value !== "boolean",
    )
  ) {
    throw new LifecycleExtensionError(
      "extension_invalid",
      `扩展 ${id} 必须声明文件、进程、网络、凭据和 UI 能力`,
    );
  }
}

function capabilitiesAllowed(
  requested: LifecycleExtensionCapabilities,
  granted: LifecycleExtensionCapabilities,
): boolean {
  const fileRank = { none: 0, read: 1, write: 2 } as const;
  return (
    fileRank[requested.files] <= fileRank[granted.files] &&
    (!requested.process || granted.process) &&
    (!requested.network || granted.network) &&
    (!requested.credentials || granted.credentials) &&
    (!requested.ui || granted.ui)
  );
}

function clonePayload(
  value: Record<string, unknown>,
  allowCredentials: boolean,
): Readonly<Record<string, unknown>> {
  return deepFreeze(cloneValue(value, allowCredentials, new WeakSet()) as Record<string, unknown>);
}

function cloneValue(value: unknown, allowCredentials: boolean, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "<circular>";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => cloneValue(item, allowCredentials, seen));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    result[key] =
      !allowCredentials && isCredentialKey(key)
        ? "<redacted>"
        : cloneValue(item, allowCredentials, seen);
  }
  return result;
}

function isCredentialKey(key: string): boolean {
  return /(?:api.?key|authorization|credential|password|secret|token)/i.test(key);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

class ExtensionTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtensionTimeoutError()), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/(?:sk-|key-|token-)[a-z0-9_-]+/gi, "<redacted>");
}
