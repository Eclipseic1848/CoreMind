import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client, Tool, Transport } from "@modelcontextprotocol/client";
import type { ArtifactStore } from "./artifact-store.js";
import type { McpAuthenticationBinding } from "./mcp-authentication.js";
import { MCP_MAX_FRAME_BYTES, McpStdioError } from "./mcp-stdio-transport.js";

/** 仅供同仓 Runtime 使用；快照保留原目录字段，不暴露 SDK 类型。 */
export interface McpListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly schemaSha256: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface McpToolResult {
  text: string;
  details: unknown;
  isError?: boolean;
}

/** 仅供同仓 Runtime 使用，不暴露第三方协议类型。 */
export interface McpClient<Summary = unknown> {
  readonly environmentSummary: Summary | undefined;
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<readonly McpListedTool[]>;
  callTool(
    tool: McpListedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface ManagedClientOptions<Summary> {
  transport: Transport & { readonly environmentSummary: Summary | undefined };
  mode: "stdio" | "http";
  signal?: AbortSignal;
  protocolVersion?: "legacy" | "2026-07-28";
  sensitiveValues?: readonly string[];
  authentication?: McpAuthenticationBinding;
  artifactStore: ArtifactStore;
  allowedResourceUris?: readonly string[];
  isFatalTransportError?: (cause: unknown) => boolean;
  onToolsChanged?: () => void;
}

const MAX_LIST_PAGES = 32;
const MAX_TOOLS = 256;
const MAX_DESCRIPTION_BYTES = 4_096;
const INLINE_RESULT_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** 两种传输共用协议、快照和结果边界；仅传输拥有实际连接资源。 */
export class ManagedMcpClient<Summary> implements McpClient<Summary> {
  private readonly definitions = new WeakMap<McpListedTool, Tool>();
  private readonly secrets: readonly string[];
  private client?: Client;
  private connected?: Promise<void>;
  private closed?: Promise<void>;
  private invalidated = false;
  private fatalError?: McpStdioError;
  private ready = false;
  private tools?: readonly McpListedTool[];

  private readonly owner = new AbortController();
  private readonly allowedResourceUris: ReadonlySet<string>;
  private isNonFatalSdkError: (cause: unknown) => boolean = () => false;
  private readonly ownerCancelled = () => {
    void this.close().catch(() => {});
  };

  constructor(private readonly options: ManagedClientOptions<Summary>) {
    this.secrets = [...new Set(options.sensitiveValues ?? [])].filter((value) => value.length > 0);
    this.allowedResourceUris = new Set(options.allowedResourceUris ?? []);
    if (options.mode === "http")
      options.signal?.addEventListener("abort", this.ownerCancelled, { once: true });
  }

  get environmentSummary(): Summary | undefined {
    return this.options.transport.environmentSummary;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.options.mode === "http" && signal?.aborted)
      return Promise.reject(error("mcp_request_cancelled", "工具连接等待已取消"));
    if (!this.connected) {
      // HTTP 握手属于 owner，首个资源等待者不能取消整个共享连接。
      this.connected = this.perform(
        this.options.mode === "http" ? undefined : signal,
        async (executionSignal) => {
          const startupTrace = Reflect.get(
            globalThis,
            Symbol.for("coremind.mcpStartup.capture"),
          )?.();
          startupTrace?.("client_sdk_import_begin");
          const {
            Client: SdkClient,
            SdkError,
            SdkErrorCode,
            SdkHttpError,
            ProtocolError,
          } = await import("@modelcontextprotocol/client");
          startupTrace?.("client_sdk_import_done");
          this.isNonFatalSdkError = (cause) =>
            cause instanceof ProtocolError ||
            cause instanceof SdkHttpError ||
            (cause instanceof SdkError &&
              (cause.code === SdkErrorCode.RequestTimeout ||
                cause.code === SdkErrorCode.CapabilityNotSupported));
          const client = new SdkClient(
            { name: "coremind", version: "1" },
            {
              capabilities: {},
              enforceStrictCapabilities: true,
              versionNegotiation: {
                mode:
                  this.options.protocolVersion === "2026-07-28" ? { pin: "2026-07-28" } : "legacy",
              },
              inputRequired: { autoFulfill: false },
            },
          );
          this.client = client;
          client.onerror = (cause) => {
            if (this.options.mode === "stdio" || this.isFatal(cause)) {
              this.fatalError ??=
                cause instanceof McpStdioError
                  ? cause
                  : error("mcp_protocol_error", "工具协议连接失效");
              this.invalidated = true;
              void this.close().catch(() => {});
            }
          };
          client.setNotificationHandler("notifications/tools/list_changed", () => {
            this.invalidated = true;
            this.options.onToolsChanged?.();
          });
          startupTrace?.("sdk_client_connect_begin");
          await client.connect(this.options.transport, requestOptions(executionSignal));
          startupTrace?.("sdk_client_connect_fulfilled");
          this.assertSafe(client.getServerVersion());
          this.assertSafe(client.getInstructions());
          this.ready = true;
        },
      );
    }
    return this.options.mode === "http" ? waitFor(this.connected, signal) : this.connected;
  }

  async listTools(signal?: AbortSignal): Promise<readonly McpListedTool[]> {
    return this.perform(signal, async (executionSignal) => {
      this.assertReady();
      if (this.tools) return this.tools;
      const tools: McpListedTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let totalBytes = 0;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await this.client!.request(
          { method: "tools/list", ...(cursor === undefined ? {} : { params: { cursor } }) },
          requestOptions(executionSignal),
        );
        totalBytes += this.assertSafe(result);
        if (totalBytes > MCP_MAX_FRAME_BYTES)
          throw error("mcp_output_limit", "工具目录超过字节上限");
        for (const definition of result.tools) {
          if (
            names.has(definition.name) ||
            Buffer.byteLength(definition.description ?? "", "utf8") > MAX_DESCRIPTION_BYTES
          )
            throw error("mcp_invalid_directory", "工具名重复或描述超过上限");
          names.add(definition.name);
          if (tools.length >= MAX_TOOLS) throw error("mcp_output_limit", "工具目录数量超过上限");
          const frozen = freezeJson(structuredClone(definition));
          const snapshot: McpListedTool = Object.freeze({
            name: frozen.name,
            description: frozen.description ?? "",
            inputSchema: frozen.inputSchema,
            ...(frozen.outputSchema !== undefined ? { outputSchema: frozen.outputSchema } : {}),
            schemaSha256: createHash("sha256")
              .update(
                canonical({
                  inputSchema: frozen.inputSchema,
                  ...(frozen.outputSchema !== undefined
                    ? { outputSchema: frozen.outputSchema }
                    : {}),
                }),
                "utf8",
              )
              .digest("hex"),
            definition: frozen,
          });
          this.definitions.set(snapshot, frozen);
          tools.push(snapshot);
        }
        if (result.nextCursor === undefined) {
          this.tools = Object.freeze(tools);
          return this.tools;
        }
        if (cursors.has(result.nextCursor))
          throw error("mcp_invalid_directory", "工具目录分页游标未收敛");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw error("mcp_output_limit", "工具目录页数超过上限");
    });
  }

  callTool(
    tool: McpListedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    return this.perform(signal, async (executionSignal) => {
      this.assertReady();
      const definition = this.definitions.get(tool);
      if (!definition) throw error("mcp_invalid_tool", "工具快照不属于当前连接");
      this.assertSafe(args);
      const result = await this.client!.callTool(
        { name: definition.name, arguments: args },
        {
          ...requestOptions(executionSignal),
          toolDefinition: definition,
        },
      );
      this.assertSafe(result);
      if (result.content.some((item) => item.type !== "text"))
        throw error("mcp_unsupported_content", "本地工具返回了不支持的内容类型");
      const content = result.content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("\n");
      const text =
        result.structuredContent !== undefined
          ? [content, JSON.stringify(result.structuredContent)]
              .filter((part) => part.length > 0)
              .join("\n")
          : content;
      return this.packageResult(result, text, result.isError);
    });
  }

  async listResources(signal?: AbortSignal): Promise<McpToolResult> {
    this.assertResourceScope();
    return this.perform(signal, async (executionSignal) => {
      const resources = await this.resourceDirectory("resources", executionSignal);
      const selected = resources.filter((item) => this.allowedResourceUris.has(String(item.uri)));
      const value = { resources: selected };
      return this.packageResult(value, JSON.stringify(value));
    });
  }

  async listResourceTemplates(signal?: AbortSignal): Promise<McpToolResult> {
    this.assertResourceScope();
    return this.perform(signal, async (executionSignal) => {
      const templates = await this.resourceDirectory("resourceTemplates", executionSignal);
      const { UriTemplate } = await import("@modelcontextprotocol/client");
      const selected = templates.filter((item) => {
        const template = new UriTemplate(String(item.uriTemplate));
        return [...this.allowedResourceUris].some((uri) => template.match(uri) !== null);
      });
      const value = { resourceTemplates: selected };
      return this.packageResult(value, JSON.stringify(value));
    });
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<McpToolResult> {
    this.assertResourceScope(uri);
    return this.perform(signal, async (executionSignal) => {
      this.assertReady();
      const result = await this.client!.request(
        { method: "resources/read", params: { uri } },
        requestOptions(executionSignal),
      );
      this.assertSafe(result);
      for (const item of result.contents) {
        if (!this.allowedResourceUris.has(item.uri))
          throw error("mcp_protocol_error", "资源响应包含授权集合外的 URI");
        if ("blob" in item || !("text" in item) || typeof item.text !== "string")
          throw error("mcp_unsupported_content", "仅支持资源文本和 JSON 正文");
      }
      // URI 仅作为协议参数；正文按文本保留，不执行 HTML 或跟随链接。
      return this.packageResult(
        result,
        result.contents.map((item) => ("text" in item ? item.text : "")).join("\n"),
      );
    });
  }

  private assertResourceScope(uri?: string): void {
    if (
      this.options.mode !== "http" ||
      this.allowedResourceUris.size === 0 ||
      (uri !== undefined && !this.allowedResourceUris.has(uri))
    )
      throw error("mcp_resource_not_allowed", "资源不在本次 HTTP 连接的精确授权集合中");
  }

  private async resourceDirectory(
    kind: "resources" | "resourceTemplates",
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    this.assertReady();
    const items: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let totalBytes = 0;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const params = cursor === undefined ? {} : { params: { cursor } };
      const result =
        kind === "resources"
          ? await this.client!.request(
              { method: "resources/list", ...params },
              requestOptions(signal),
            )
          : await this.client!.request(
              { method: "resources/templates/list", ...params },
              requestOptions(signal),
            );
      totalBytes += this.assertSafe(result);
      if (totalBytes > MCP_MAX_FRAME_BYTES) throw error("mcp_output_limit", "资源目录超过字节上限");
      const entries = kind === "resources" ? result.resources : result.resourceTemplates;
      if (!Array.isArray(entries)) throw error("mcp_protocol_error", "资源目录缺少预期集合");
      for (const item of entries) {
        if (items.length >= MAX_TOOLS) throw error("mcp_output_limit", "资源目录数量超过上限");
        items.push(item);
      }
      if (result.nextCursor === undefined) return items;
      if (cursors.has(result.nextCursor))
        throw error("mcp_invalid_directory", "资源目录分页游标未收敛");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw error("mcp_output_limit", "资源目录页数超过上限");
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = this.options.transport.close();
      this.owner.abort(this.fatalError);
      this.options.signal?.removeEventListener("abort", this.ownerCancelled);
    }
    return this.closed;
  }

  private assertReady(): void {
    if (!this.client || !this.ready || this.closed || this.invalidated)
      throw error("mcp_connection_unavailable", "本地工具连接尚未就绪、已关闭或目录已变化");
  }

  private assertSafe(value: unknown): number {
    this.options.authentication?.assertActive();
    const visit = (item: unknown, depth: number): void => {
      if (depth > 64) throw error("mcp_output_limit", "本地工具数据嵌套超过上限");
      if (typeof item === "string" && this.secrets.some((secret) => item.includes(secret)))
        throw error("mcp_secret_blocked", "本地工具数据包含本次服务秘密，已阻断输出");
      if (typeof item === "string") this.options.authentication?.assertSafe(item);
      if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
      else if (item !== null && typeof item === "object")
        for (const [key, child] of Object.entries(item)) {
          visit(key, depth + 1);
          visit(child, depth + 1);
        }
    };
    visit(value, 0);
    const serialized = JSON.stringify(value) ?? "";
    visit(serialized, 0);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MCP_MAX_FRAME_BYTES) throw error("mcp_output_limit", "本地工具数据超过字节上限");
    return bytes;
  }

  private async packageResult(
    result: unknown,
    text: string,
    isError?: boolean,
  ): Promise<McpToolResult> {
    this.assertSafe(result);
    this.assertSafe(text);
    const value = { mcp: structuredClone(result) };
    const serialized = JSON.stringify(value);
    let details: unknown = value;
    if (Buffer.byteLength(serialized, "utf8") > INLINE_RESULT_BYTES) {
      const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-result-"));
      try {
        const file = path.join(directory, "result.json");
        await writeFile(file, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        const imported = await this.options.artifactStore.importFile(file, {
          deleteSource: true,
          mediaType: "application/json; charset=utf-8",
        });
        text = imported.preview;
        details = { mcp: { output: "artifact" }, artifact: imported.record };
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    return { text, details, ...(isError !== undefined ? { isError } : {}) };
  }

  private isFatal(cause: unknown): boolean {
    if (this.options.isFatalTransportError?.(cause)) return true;
    if (cause instanceof McpStdioError)
      return [
        "mcp_output_limit",
        "mcp_secret_blocked",
        "mcp_invalid_directory",
        "mcp_protocol_error",
      ].includes(cause.code);
    return !this.isNonFatalSdkError(cause);
  }

  private async perform<T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer =
      this.options.mode === "http"
        ? setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS)
        : undefined;
    const signals = [signal, this.options.signal, this.owner.signal, deadline.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const executionSignal = AbortSignal.any(signals);
    const callerSignal = AbortSignal.any(
      [signal, this.options.signal, deadline.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    );
    let callerCancelledFirst = callerSignal.aborted;
    const rememberCancellation = () => {
      if (!this.fatalError) callerCancelledFirst = true;
    };
    callerSignal.addEventListener("abort", rememberCancellation, { once: true });
    const cancel = () => {
      void this.close().catch(() => {});
    };
    try {
      if (this.closed || executionSignal.aborted)
        throw error("mcp_connection_unavailable", "工具连接已关闭或调用已取消");
      if (this.options.mode === "stdio")
        executionSignal.addEventListener("abort", cancel, { once: true });
      this.options.authentication?.assertActive();
      const result = await action(executionSignal);
      this.options.authentication?.assertActive();
      return result;
    } catch (cause) {
      // 致命检查主动关闭连接产生的取消不能覆盖原错误；用户先取消时仍保留取消语义。
      const failure = !callerCancelledFirst && this.fatalError ? this.fatalError : cause;
      if (this.options.mode === "stdio" || this.isFatal(failure)) {
        this.invalidated = true;
        await this.close();
      }
      if (failure instanceof McpStdioError) throw failure;
      if (this.options.mode === "http" && executionSignal.aborted)
        throw error("mcp_request_cancelled", "工具请求已取消或超过本次期限；不自动重试");
      throw error("mcp_protocol_error", "工具协议调用失败；远端效果可能未知，不自动重试");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      executionSignal.removeEventListener("abort", cancel);
      callerSignal.removeEventListener("abort", rememberCancellation);
    }
  }
}

function requestOptions(signal: AbortSignal) {
  return {
    signal,
    timeout: REQUEST_TIMEOUT_MS,
    maxTotalTimeout: REQUEST_TIMEOUT_MS,
    resetTimeoutOnProgress: false,
  };
}

function error(code: string, message: string): McpStdioError {
  return new McpStdioError(code, message);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** 只取消本次等待，不把调用者的生命周期移交给共享握手。 */
function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const cancelled = () => reject(error("mcp_request_cancelled", "工具连接等待已取消"));
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancelled));
  });
}
