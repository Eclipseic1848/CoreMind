import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client, Tool } from "@modelcontextprotocol/client";
import type { ArtifactStore } from "./artifact-store.js";
import type { ExecutionEnvironment } from "./execution-environment.js";
import { MCP_MAX_FRAME_BYTES, McpStdioError, McpStdioTransport } from "./mcp-stdio-transport.js";

/** 仅供同仓 Runtime 使用；快照保留原目录字段，不暴露 SDK 类型。 */
export interface McpListedTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly schemaSha256: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface McpStdioClientOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  runEnvironment: ExecutionEnvironment;
  signal?: AbortSignal;
  protocolVersion?: "legacy" | "2026-07-28";
  sensitiveValues?: readonly string[];
  artifactStore: ArtifactStore;
}

export interface McpStdioToolResult {
  text: string;
  details: unknown;
  isError?: boolean;
}

export interface McpStdioDomainSummary {
  readonly isolation: "trusted_host";
  readonly processControl: "process_tree";
  readonly networkEgress: "unrestricted";
  readonly credentialIsolation: "none";
  readonly platform: NodeJS.Platform;
  readonly evidence: readonly string[];
}

/** 创建零 I/O；只有已获准的 connect/list/call 才能触发对应协议动作。 */
export interface McpStdioClient {
  readonly environmentSummary: McpStdioDomainSummary | undefined;
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<readonly McpListedTool[]>;
  callTool(
    tool: McpListedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpStdioToolResult>;
  close(): Promise<void>;
}

const MAX_LIST_PAGES = 32;
const MAX_TOOLS = 256;
const MAX_DESCRIPTION_BYTES = 4_096;
const INLINE_RESULT_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

/** 工厂仅冻结输入；SDK 与进程环境只在授权 connect 时加载。 */
export function createMcpStdioClient(options: McpStdioClientOptions): McpStdioClient {
  return new ManagedMcpClient({
    ...options,
    args: Object.freeze([...options.args]),
    env: Object.freeze({ ...options.env }),
    sensitiveValues: Object.freeze([...(options.sensitiveValues ?? [])]),
  });
}

class ManagedMcpClient implements McpStdioClient {
  private readonly transport: McpStdioTransport;
  private readonly definitions = new WeakMap<McpListedTool, Tool>();
  private readonly secrets: readonly string[];
  private client?: Client;
  private connected?: Promise<void>;
  private closed?: Promise<void>;
  private invalidated = false;
  private ready = false;
  private tools?: readonly McpListedTool[];

  constructor(private readonly options: McpStdioClientOptions) {
    this.transport = new McpStdioTransport(options);
    this.secrets = [...new Set(options.sensitiveValues ?? [])].filter((value) => value.length > 0);
  }

  get environmentSummary(): McpStdioDomainSummary | undefined {
    return this.transport.environmentSummary;
  }

  connect(signal?: AbortSignal): Promise<void> {
    if (this.connected) return this.connected;
    this.connected = this.perform(signal, async (executionSignal) => {
      const { Client: SdkClient } = await import("@modelcontextprotocol/client");
      const client = new SdkClient(
        { name: "coremind", version: "1" },
        {
          capabilities: {},
          enforceStrictCapabilities: true,
          versionNegotiation: {
            mode: this.options.protocolVersion === "2026-07-28" ? { pin: "2026-07-28" } : "legacy",
          },
          inputRequired: { autoFulfill: false },
        },
      );
      this.client = client;
      client.onerror = () => {
        this.invalidated = true;
        void this.close().catch(() => {});
      };
      client.setNotificationHandler("notifications/tools/list_changed", () => {
        this.invalidated = true;
      });
      await client.connect(this.transport, requestOptions(executionSignal));
      this.assertSafe(client.getServerVersion());
      this.assertSafe(client.getInstructions());
      this.ready = true;
    });
    return this.connected;
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
  ): Promise<McpStdioToolResult> {
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
      const value = { mcp: structuredClone(result) };
      const serialized = JSON.stringify(value);
      let text =
        result.structuredContent !== undefined
          ? [content, JSON.stringify(result.structuredContent)]
              .filter((part) => part.length > 0)
              .join("\n")
          : content;
      this.assertSafe(text);
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
      return {
        text,
        details,
        ...(result.isError !== undefined ? { isError: result.isError } : {}),
      };
    });
  }

  close(): Promise<void> {
    if (!this.closed) this.closed = this.transport.close();
    return this.closed;
  }

  private assertReady(): void {
    if (!this.client || !this.ready || this.closed || this.invalidated)
      throw error("mcp_connection_unavailable", "本地工具连接尚未就绪、已关闭或目录已变化");
  }

  private assertSafe(value: unknown): number {
    const visit = (item: unknown, depth: number): void => {
      if (depth > 64) throw error("mcp_output_limit", "本地工具数据嵌套超过上限");
      if (typeof item === "string" && this.secrets.some((secret) => item.includes(secret)))
        throw error("mcp_secret_blocked", "本地工具数据包含本次服务秘密，已阻断输出");
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

  private async perform<T>(
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signals = [signal, this.options.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    );
    const executionSignal = AbortSignal.any(signals);
    if (this.closed || executionSignal.aborted)
      throw error("mcp_connection_unavailable", "本地工具连接已关闭或调用已取消");
    const cancel = () => {
      void this.close().catch(() => {});
    };
    executionSignal.addEventListener("abort", cancel, { once: true });
    try {
      return await action(executionSignal);
    } catch (cause) {
      await this.close();
      throw cause instanceof McpStdioError
        ? cause
        : error("mcp_protocol_error", "本地工具协议调用失败；远端效果可能未知，不自动重试");
    } finally {
      executionSignal.removeEventListener("abort", cancel);
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
