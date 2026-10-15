import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { ReadableStream } from "node:stream/web";
import { TextDecoder } from "node:util";
import type { FetchLike } from "@modelcontextprotocol/client";
import type { Dispatcher } from "undici";
import {
  type ExecutionEnvironment,
  type ExecutionEnvironmentActivity,
  resolveExecutionEnvironment,
} from "./execution-environment.js";
import type { McpAuthenticationBinding } from "./mcp-authentication.js";
import { McpStdioError } from "./mcp-stdio-transport.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_OWNER_BYTES = 64 * 1024 * 1024;
const MAX_GETS = 3;
const GET_WINDOW_MS = 30_000;
const RESERVED_HEADERS = new Set([
  "host",
  "connection",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "dpop",
  "content-length",
  "transfer-encoding",
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
]);

export interface McpHttpTransportOptions {
  readonly url: string;
  readonly allowedAddresses?: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly runEnvironment: ExecutionEnvironment;
  readonly signal?: AbortSignal;
  readonly sensitiveValues?: readonly string[];
  readonly authentication?: McpAuthenticationBinding;
}

export interface McpHttpDomainSummary {
  readonly isolation: "trusted_host";
  readonly processControl: "none";
  readonly networkEgress: "adapter_scoped";
  readonly credentialIsolation: "none";
  readonly platform: NodeJS.Platform;
  readonly evidence: readonly string[];
}

interface OwnedRequest {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  cancel(): Promise<void>;
}

/** 固定目标的私有网络 owner；构造不解析域名、不创建连接。 */
export function createMcpHttpFetch(options: McpHttpTransportOptions): McpHttpFetchOwner {
  return new McpHttpFetchOwner(options);
}

export class McpHttpFetchOwner {
  environmentSummary: McpHttpDomainSummary | undefined;
  readonly fetch: FetchLike;
  private readonly url: URL;
  private readonly headers: Headers;
  private readonly allowed: readonly string[];
  private readonly secrets: readonly string[];
  private readonly controller = new AbortController();
  private readonly requests = new Set<OwnedRequest>();
  private agent?: Dispatcher;
  private closing?: Promise<void>;
  private bytes = 0;
  private gets = 0;
  private firstGet?: number;
  private fatal?: McpStdioError;

  constructor(private readonly options: McpHttpTransportOptions) {
    this.url = parseTarget(options.url);
    this.allowed = Object.freeze((options.allowedAddresses ?? []).map(normalizeAddress));
    this.secrets = Object.freeze((options.sensitiveValues ?? []).filter(Boolean));
    try {
      this.headers = new Headers();
      const names = new Set<string>();
      for (const [name, value] of Object.entries(options.headers)) {
        const folded = name.toLowerCase();
        if (
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
          names.has(folded) ||
          RESERVED_HEADERS.has(folded) ||
          typeof value !== "string" ||
          [...value].some((character) => {
            const code = character.charCodeAt(0);
            return (code < 32 && code !== 9) || code === 127;
          })
        )
          throw policy();
        names.add(folded);
        this.headers.append(name, value);
      }
      if (Buffer.byteLength(JSON.stringify([...this.headers]), "utf8") > 16 * 1024) throw policy();
    } catch {
      throw policy();
    }
    this.fetch = (input, init) => this.request(input, init);
  }

  get remainingGetWindowMs(): number {
    return this.firstGet === undefined
      ? GET_WINDOW_MS
      : Math.max(0, GET_WINDOW_MS - (performance.now() - this.firstGet));
  }

  get closed(): boolean {
    return Boolean(
      this.fatal || this.closing || this.controller.signal.aborted || this.options.signal?.aborted,
    );
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    const requests = [...this.requests];
    const results = await Promise.allSettled([
      ...requests.map((request) => request.cancel()),
      ...(this.agent ? [this.agent.destroy()] : []),
    ]);
    await Promise.all(requests.map((request) => request.done));
    if (results.some((result) => result.status === "rejected"))
      throw new McpStdioError("mcp_cleanup_failed", "远程连接未能完整关闭");
  }

  private async request(
    input: Parameters<FetchLike>[0],
    init: Parameters<FetchLike>[1] = {},
  ): Promise<Response> {
    this.checkOpen();
    let target: URL;
    try {
      target = new URL(input);
    } catch {
      throw policy();
    }
    if (target.href !== this.url.href) throw policy();
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw policy();
    if (method === "GET") {
      this.firstGet ??= performance.now();
      if (this.gets >= MAX_GETS || this.remainingGetWindowMs <= 0)
        throw this.fail(new McpStdioError("mcp_http_limit_exceeded", "远程事件恢复预算已用尽"));
      this.gets += 1;
    }
    const hostname = this.url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname)) validateMcpHttpAddress(hostname, this.url.protocol, this.allowed);
    const headers = new Headers(init.headers);
    for (const [name, value] of this.headers) {
      if (headers.has(name) && headers.get(name) !== value) throw policy();
      headers.set(name, value);
    }
    if (
      [
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "proxy-authorization",
        "proxy-connection",
        "dpop",
      ].some((name) => headers.has(name))
    )
      throw policy();
    if (typeof init.body === "string" && Buffer.byteLength(init.body, "utf8") > MAX_BODY_BYTES)
      throw this.fail(new McpStdioError("mcp_http_limit_exceeded", "远程请求超过上限"));
    const activities: ExecutionEnvironmentActivity[] = [];
    const requestController = new AbortController();
    const signal = AbortSignal.any([
      this.controller.signal,
      requestController.signal,
      ...(this.options.authentication ? [this.options.authentication.signal] : []),
      ...(this.options.signal ? [this.options.signal] : []),
      ...(init.signal ? [init.signal] : []),
    ]);
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let finished = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", aborted);
      for (const activity of activities) activity.settle();
      this.requests.delete(owned);
      settle();
    };
    const cancel = async () => {
      requestController.abort();
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          /* 取消后的管道错误不携带远端原文。 */
        }
        finish();
      }
    };
    const owned: OwnedRequest = { controller: requestController, done, cancel };
    const aborted = () => {
      try {
        output?.error(this.fatal ?? cancelled());
      } catch {
        /* 已结算的流无需重复报错。 */
      }
      if (reader) void cancel();
    };
    this.requests.add(owned);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      const domain = this.options.runEnvironment.hostNetwork ?? this.options.runEnvironment;
      activities.push(
        this.options.runEnvironment.beginActivity({
          id: `mcp-http-run:${randomUUID()}`,
          kind: "network",
        }),
      );
      if (domain !== this.options.runEnvironment)
        activities.push(
          domain.beginActivity({ id: `mcp-http-domain:${randomUUID()}`, kind: "network" }),
        );
      for (const activity of activities) {
        if (activity.signal.aborted) requestController.abort();
        else
          activity.signal.addEventListener("abort", () => requestController.abort(), {
            once: true,
            signal,
          });
      }
      const resolved = await resolveExecutionEnvironment(domain, {});
      if (resolved.capabilities.networkEgress !== "unrestricted") throw policy();
      this.checkOpen();
      if (signal.aborted) throw cancelled();
      if (this.options.authentication) {
        if (headers.has("authorization")) throw policy();
        const token = await this.options.authentication.authorize(signal);
        this.checkOpen();
        if (signal.aborted) throw cancelled();
        headers.set("authorization", `Bearer ${token}`);
      }
      this.environmentSummary = Object.freeze({
        isolation: "trusted_host",
        processControl: "none",
        networkEgress: "adapter_scoped",
        credentialIsolation: "none",
        platform: resolved.capabilities.identity.platform,
        evidence: Object.freeze([
          ...resolved.evidence,
          "fixed-target-socket-address-validation",
          "private-http-dispatcher",
        ]),
      });
      const { Agent: HttpAgent, fetch: dispatchFetch } = await import("undici");
      this.checkOpen();
      if (signal.aborted) throw cancelled();
      this.agent ??= new HttpAgent({
        connections: 8,
        pipelining: 1,
        maxOrigins: 1,
        allowH2: false,
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
        connectTimeout: 10_000,
        maxHeaderSize: 16 * 1024,
        connect: { lookup: this.lookup, autoSelectFamily: false },
      }).compose(preventMisdirectedReplay);
      const response = await dispatchFetch(this.url, {
        method,
        headers: Array.from(headers),
        body: init.body as string | undefined,
        signal,
        redirect: "manual",
        dispatcher: this.agent,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw policy();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new McpStdioError(
          response.status === 401 || response.status === 403
            ? this.options.authentication
              ? "mcp_auth_required"
              : "mcp_http_auth_required"
            : "mcp_http_status_error",
          response.status === 401 || response.status === 403
            ? "远程服务拒绝当前凭证"
            : "远程服务返回失败状态",
        );
      }
      this.assertSafe(JSON.stringify([...response.headers]));
      for (const [name, value] of response.headers) {
        this.assertSafe(name);
        this.assertSafe(value);
      }
      if (!response.body) {
        finish();
        return new Response(null, { status: response.status, headers: response.headers });
      }
      reader = response.body.getReader();
      if (signal.aborted) throw cancelled();
      let bodyBytes = 0;
      let eventBytes = 0;
      let lineBytes = 0;
      let previousCr = false;
      let tail = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const overlap = Math.max(
        0,
        ...this.secrets.map((value) => value.length - 1),
        // 在飞响应也须认识之后轮换的新令牌，保留有界的最大重叠长度。
        (this.options.authentication?.maxSecretLength ?? 1) - 1,
      );
      const sse =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
        "text/event-stream";
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          output = controller;
        },
        pull: async (controller) => {
          try {
            if (signal.aborted) throw this.fatal ?? cancelled();
            const result = await reader!.read();
            if (result.done) {
              let end: string;
              try {
                end = decoder.decode();
              } catch {
                throw invalidUtf8();
              }
              this.assertSafe(tail + end);
              finish();
              controller.close();
              return;
            }
            bodyBytes += result.value.byteLength;
            this.bytes += result.value.byteLength;
            if (bodyBytes > MAX_BODY_BYTES || this.bytes > MAX_OWNER_BYTES)
              throw new McpStdioError("mcp_http_limit_exceeded", "远程响应超过上限");
            if (sse)
              for (const byte of result.value) {
                eventBytes += 1;
                if (eventBytes > MAX_BODY_BYTES)
                  throw new McpStdioError("mcp_http_limit_exceeded", "远程事件超过上限");
                if (byte === 10 && previousCr) {
                  previousCr = false;
                  continue;
                }
                if (byte === 10 || byte === 13) {
                  if (lineBytes === 0) eventBytes = 0;
                  lineBytes = 0;
                  previousCr = byte === 13;
                } else {
                  lineBytes += 1;
                  previousCr = false;
                }
              }
            let text: string;
            try {
              text = decoder.decode(result.value, { stream: true });
            } catch {
              throw invalidUtf8();
            }
            this.assertSafe(tail + text);
            tail = overlap ? (tail + text).slice(-overlap) : "";
            controller.enqueue(result.value);
          } catch (error) {
            let safe = this.normalize(error, signal);
            let recover =
              method === "GET" && sse && !signal.aborted && safe.code === "mcp_http_request_failed";
            if (recover) {
              try {
                this.assertSafe(tail + decoder.decode());
              } catch (cause) {
                safe = cause instanceof McpStdioError ? cause : invalidUtf8();
                recover = false;
              }
            }
            try {
              // 仅实际 GET 事件流的网络断开交由官方 EOF 恢复；协议和安全失败仍立即失效。
              if (recover) controller.close();
              else controller.error(safe);
            } catch {
              /* 取消可能已结算该流。 */
            }
            if (isMcpHttpFatalError(safe)) this.fail(safe);
            await cancel();
          }
        },
        cancel: async () => {
          await cancel();
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      const safe = this.normalize(error, signal);
      if (isMcpHttpFatalError(safe)) this.fail(safe);
      await cancel();
      finish();
      throw safe;
    }
  }

  private readonly lookup: LookupFunction = (hostname, options, callback) => {
    if (hostname !== this.url.hostname.replace(/^\[|\]$/g, "")) {
      callback(policy(), "");
      return;
    }
    void dns
      .lookup(hostname, { all: true, verbatim: true })
      .then((records) => {
        this.checkOpen();
        if (!records.length) throw policy();
        const addresses = records.map(({ address }) => {
          const approved = validateMcpHttpAddress(address, this.url.protocol, this.allowed);
          return { address: approved, family: isIP(approved) };
        });
        // 将同一次完整校验的结果直接交给 socket，不让连接再次解析域名。
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      })
      .catch((error: unknown) => {
        const safe =
          error instanceof McpStdioError
            ? error
            : new McpStdioError("mcp_http_request_failed", "远程地址解析失败");
        if (isMcpHttpFatalError(safe)) this.fail(safe);
        callback(safe, "");
      });
  };

  private checkOpen(): void {
    this.options.authentication?.assertActive();
    if (this.fatal) throw this.fatal;
    if (this.closing || this.controller.signal.aborted || this.options.signal?.aborted)
      throw cancelled();
  }

  private assertSafe(text: string): void {
    this.options.authentication?.assertSafe(text);
    if (this.secrets.some((secret) => text.includes(secret)))
      throw new McpStdioError("mcp_secret_blocked", "远程响应包含受保护凭证");
  }

  private normalize(error: unknown, signal: AbortSignal): McpStdioError {
    if (this.fatal) return this.fatal;
    if (error instanceof McpStdioError) return error;
    if (error instanceof Error && error.cause instanceof McpStdioError) return error.cause;
    if (signal.aborted) return cancelled();
    return new McpStdioError("mcp_http_request_failed", "远程连接失败，操作结果可能未知");
  }

  private fail(error: McpStdioError): McpStdioError {
    this.fatal ??= error;
    this.controller.abort();
    return this.fatal;
  }
}

// fetch 会透明重发 421；在其读取状态前中止，保证有副作用的 POST 只发送一次。
const preventMisdirectedReplay: Dispatcher.DispatcherComposeInterceptor =
  (dispatch) => (options, handler) =>
    dispatch(
      options,
      new Proxy(handler, {
        get(target, key) {
          if (key === "onResponseStart") {
            const onResponseStart: NonNullable<Dispatcher.DispatchHandler["onResponseStart"]> = (
              controller,
              status,
              headers,
              message,
            ) => {
              if (status === 421) {
                controller.abort(
                  new McpStdioError("mcp_http_status_error", "远程服务返回失败状态"),
                );
                return;
              }
              target.onResponseStart?.(controller, status, headers, message);
            };
            return onResponseStart;
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );

export function isMcpHttpFatalError(error: unknown): boolean {
  return (
    error instanceof McpStdioError &&
    [
      "mcp_http_policy_denied",
      "mcp_http_limit_exceeded",
      "mcp_secret_blocked",
      "mcp_protocol_error",
      "mcp_cleanup_failed",
    ].includes(error.code)
  );
}

function parseTarget(value: string): URL {
  try {
    if (
      value !== value.trim() ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
      )
    )
      throw policy();
    const authority = /^[^:]+:\/\/([^/?#]*)/.exec(value)?.[1];
    if (!authority || authority.includes("@")) throw policy();
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      value.includes("?") ||
      value.includes("#")
    )
      throw policy();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const rawHostname = authority.startsWith("[")
      ? authority.slice(1, authority.indexOf("]"))
      : authority.split(":", 1)[0]!;
    if (
      url.protocol === "http:" &&
      (!isIP(rawHostname) || !isIP(hostname) || !isLoopback(normalizeAddress(hostname)))
    )
      throw policy();
    return url;
  } catch {
    throw policy();
  }
}

/** 返回规范化 socket 地址；映射 IPv4 与普通 IPv4 使用同一权限身份。 */
export function validateMcpHttpAddress(
  address: string,
  protocol: string,
  allowed: readonly string[],
): string {
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  let privateAddress = false;
  if (family === 4) {
    const [a, b, c] = normalized.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a >= 224 || (a === 169 && b === 254)) throw policy();
    privateAddress =
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
    if (
      !privateAddress &&
      ((a === 192 && b === 0 && (c === 0 || c === 2)) ||
        (a === 192 && b === 88 && c === 99) ||
        (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113))
    )
      throw policy();
  } else {
    const words = ipv6Words(normalized);
    const first = words[0]!;
    if (
      words.every((word) => word === 0) ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00
    )
      throw policy();
    privateAddress = isLoopback(normalized) || (first & 0xfe00) === 0xfc00;
    if (
      !privateAddress &&
      ((first & 0xe000) !== 0x2000 ||
        (first === 0x2001 && words[1]! < 0x200) ||
        first === 0x2002 ||
        (first === 0x2001 && words[1] === 0xdb8) ||
        (first === 0x3fff && words[1]! < 0x1000))
    )
      throw policy();
  }
  const explicitlyAllowed = allowed.some((value) => normalizeAddress(value) === normalized);
  if (allowed.length > 0 && !explicitlyAllowed) throw policy();
  if (
    protocol === "http:"
      ? !isLoopback(normalized) || !explicitlyAllowed
      : protocol !== "https:" || (privateAddress && !explicitlyAllowed)
  )
    throw policy();
  return normalized;
}

function normalizeAddress(value: string): string {
  if (typeof value !== "string" || value.includes("%")) throw policy();
  const address = value.replace(/^\[|\]$/g, "");
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) throw policy();
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const words = ipv6Words(canonical);
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff)
    return `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`;
  return canonical;
}

function ipv6Words(address: string): number[] {
  const [left, right] = address.split("::");
  const before = left ? left.split(":").map((value) => Number.parseInt(value, 16)) : [];
  const after = right ? right.split(":").map((value) => Number.parseInt(value, 16)) : [];
  return right === undefined
    ? before
    : [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
}

function isLoopback(address: string): boolean {
  return address.startsWith("127.") || address === "::1";
}

function policy(): McpStdioError {
  return new McpStdioError("mcp_http_policy_denied", "远程目标或请求不符合网络授权");
}

function cancelled(): McpStdioError {
  return new McpStdioError("mcp_request_cancelled", "远程请求已取消或关闭");
}

function invalidUtf8(): McpStdioError {
  return new McpStdioError("mcp_protocol_error", "远程响应不是有效 UTF-8");
}
