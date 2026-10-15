import type {
  JSONRPCMessage,
  StreamableHTTPClientTransport,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";
import {
  createMcpHttpFetch,
  isMcpHttpFatalError,
  type McpHttpDomainSummary,
  type McpHttpFetchOwner,
  type McpHttpTransportOptions,
} from "./mcp-http-fetch.js";
import { McpStdioError } from "./mcp-stdio-transport.js";

export {
  isMcpHttpFatalError,
  type McpHttpDomainSummary,
  type McpHttpTransportOptions,
} from "./mcp-http-fetch.js";

/** 不含 OAuth、远端 DELETE 或自动业务重放的私有 HTTP 传输。 */
export function createMcpHttpTransport(options: McpHttpTransportOptions): McpHttpTransport {
  return new McpHttpTransport(options);
}

interface PendingHttpRequest {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  release(): void;
}

export class McpHttpTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  readonly hasPerRequestStream = true;
  private readonly owner: McpHttpFetchOwner;
  private readonly requests = new Map<string | number, PendingHttpRequest>();
  private readonly reconnectTimers = new Set<ReturnType<typeof setTimeout>>();
  private transport?: StreamableHTTPClientTransport;
  private started = false;
  private notified = false;
  private closing?: Promise<void>;
  private version?: string;

  constructor(private readonly options: McpHttpTransportOptions) {
    this.owner = createMcpHttpFetch(options);
  }

  get environmentSummary(): McpHttpDomainSummary | undefined {
    return this.owner.environmentSummary;
  }

  get sessionId(): string | undefined {
    return this.transport?.sessionId;
  }

  get protocolVersion(): string | undefined {
    return this.transport?.protocolVersion ?? this.version;
  }

  setProtocolVersion(version: string): void {
    this.version = version;
    this.transport?.setProtocolVersion(version);
  }

  async start(): Promise<void> {
    if (this.started || this.closing) throw protocolFailure();
    this.started = true;
    if (this.options.signal?.aborted) throw cancelled();
    const { StreamableHTTPClientTransport: HttpTransport } = await import(
      "@modelcontextprotocol/client"
    );
    if (this.closing || this.options.signal?.aborted) throw cancelled();
    this.transport = new HttpTransport(new URL(this.options.url), {
      fetch: this.owner.fetch,
      requestInit: { headers: this.options.headers, redirect: "manual" },
      protocolVersion: this.version,
      onInsufficientScope: "throw",
      maxStepUpRetries: 0,
      reconnectionOptions: {
        maxRetries: 3,
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 1_000,
        reconnectionDelayGrowFactor: 2,
      },
      reconnectionScheduler: (reconnect, delay) => {
        if (this.closing || this.owner.closed) return;
        const bounded = Math.max(
          0,
          Math.min(Number.isFinite(delay) ? delay : 1_000, 1_000, this.owner.remainingGetWindowMs),
        );
        const timer = setTimeout(() => {
          this.reconnectTimers.delete(timer);
          reconnect();
        }, bounded);
        this.reconnectTimers.add(timer);
        return () => {
          clearTimeout(timer);
          this.reconnectTimers.delete(timer);
        };
      },
    });
    this.transport.onmessage = (message) => {
      if ("id" in message && message.id !== undefined && !("method" in message))
        this.requests.get(message.id)?.release();
      this.onmessage?.(message);
    };
    this.transport.onerror = (error) => this.onerror?.(safeError(error));
    await this.transport.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (!this.transport || this.closing || this.options.signal?.aborted) throw cancelled();
    let request: PendingHttpRequest | undefined;
    if ("method" in message && "id" in message) {
      const id = message.id;
      if (this.requests.has(id) || this.requests.size >= 256) throw protocolFailure();
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        ...(options?.requestSignal ? [options.requestSignal] : []),
      ]);
      const release = () => {
        signal.removeEventListener("abort", release);
        if (this.requests.get(id)?.controller === controller) this.requests.delete(id);
      };
      request = { controller, signal, release };
      this.requests.set(id, request);
      signal.addEventListener("abort", release, { once: true });
      if (signal.aborted) release();
    }
    // 旧协议通过通知取消；同时精确关闭本地对应流，不波及其他合法请求。
    const cancelling = "method" in message && message.method === "notifications/cancelled";
    if ("method" in message && message.method === "notifications/cancelled") {
      const id = (message.params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof id === "string" || typeof id === "number") {
        const pending = this.requests.get(id);
        pending?.controller.abort();
        pending?.release();
        message = {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason: "请求已取消" },
        };
      }
    }
    const signal = request?.signal ?? options?.requestSignal;
    try {
      await this.transport.send(message, {
        ...options,
        ...(signal ? { requestSignal: signal } : {}),
      });
    } catch (error) {
      request?.release();
      // 本地对应流已取消；远端取消通知尽力发送，避免 SDK 二次包装误杀其他请求。
      if (cancelling && error instanceof McpStdioError && !isMcpHttpFatalError(error)) return;
      throw error instanceof McpStdioError
        ? error
        : signal?.aborted
          ? cancelled()
          : safeError(error);
    }
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<void> {
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const request of this.requests.values()) {
      request.controller.abort();
      request.release();
    }
    this.requests.clear();
    const results = await Promise.allSettled([
      ...(this.transport ? [this.transport.close()] : []),
      this.owner.close(),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new McpStdioError("mcp_cleanup_failed", "远程连接未能完整关闭");
    this.notifyClosed();
  }

  private notifyClosed(): void {
    if (this.notified) return;
    this.notified = true;
    this.onclose?.();
  }
}

function safeError(error: unknown): McpStdioError {
  return error instanceof McpStdioError ? error : protocolFailure();
}

function protocolFailure(): McpStdioError {
  return new McpStdioError("mcp_protocol_error", "远程协议响应无效");
}

function cancelled(): McpStdioError {
  return new McpStdioError("mcp_request_cancelled", "远程请求已取消或关闭");
}
