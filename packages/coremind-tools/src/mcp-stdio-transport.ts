import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import type { JSONRPCMessage, ReadBuffer, Transport } from "@modelcontextprotocol/client";
import { execa, type Subprocess } from "execa";
import {
  createTrustedHostExecutionEnvironment,
  type ExecutionEnvironmentActivity,
  resolveExecutionEnvironment,
} from "./execution-environment.js";
import type { McpStdioClientOptions, McpStdioDomainSummary } from "./mcp-stdio-client.js";
import { probeProcessTreeTermination } from "./process-runner.js";

export const MCP_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 1024 * 1024;
type ManagedProcess = Subprocess<{ encoding: "buffer"; buffer: false; reject: false }>;

/** 稳定错误不携带 SDK、进程环境、stderr 或远端原文。 */
export class McpStdioError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpStdioError";
  }
}

/** 私有传输只管理本次连接；权限准入由调用方在 connect 前完成。 */
export class McpStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  environmentSummary: McpStdioDomainSummary | undefined;
  private process?: ManagedProcess;
  private reader?: ReadBuffer;
  private serialize?: typeof import("@modelcontextprotocol/client").serializeMessage;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly controller = new AbortController();
  private readonly activities: ExecutionEnvironmentActivity[] = [];
  private readonly writes = new Set<(error: Error) => void>();
  private finished?: Promise<void>;
  private closing?: Promise<void>;
  private started = false;
  private notified = false;
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private partialBytes = 0;
  private pendingWriteBytes = 0;

  constructor(private readonly options: McpStdioClientOptions) {}

  async start(): Promise<void> {
    if (this.started || this.closing) throw failure("连接不能重复启动");
    this.started = true;
    this.throwIfAborted();
    try {
      const domain = createTrustedHostExecutionEnvironment({
        workspaceRoot: this.options.cwd,
        probeProcessControl: probeProcessTreeTermination,
      });
      this.activities.push(
        this.options.runEnvironment.beginActivity({
          id: `mcp-run:${randomUUID()}`,
          kind: "process",
        }),
      );
      const resolved = await resolveExecutionEnvironment(domain, {
        processControl: "process_tree",
        termination: { kill: "process_tree", timeout: true },
      });
      this.throwIfAborted();
      if (this.activities.some((activity) => activity.signal.aborted))
        throw failure("连接启动前已取消");
      this.environmentSummary = Object.freeze({
        isolation: "trusted_host",
        processControl: "process_tree",
        networkEgress: "unrestricted",
        credentialIsolation: "none",
        platform: resolved.capabilities.identity.platform,
        evidence: Object.freeze([...resolved.evidence]),
      });
      this.activities.push(
        domain.beginActivity({ id: `mcp-process:${randomUUID()}`, kind: "process" }),
      );
      const signal = AbortSignal.any([
        this.controller.signal,
        ...this.activities.map((activity) => activity.signal),
        ...(this.options.signal ? [this.options.signal] : []),
      ]);
      if (signal.aborted) throw failure("连接启动前已取消");
      const { ReadBuffer: BufferReader, serializeMessage } = await import(
        "@modelcontextprotocol/client"
      );
      if (signal.aborted) throw failure("连接启动前已取消");
      this.reader = new BufferReader({ maxBufferSize: MCP_MAX_FRAME_BYTES });
      this.serialize = serializeMessage;
      const env: Record<string, string> = {};
      const keys = new Set<string>();
      for (const [name, value] of Object.entries(this.options.env)) {
        const key = process.platform === "win32" ? name.toUpperCase() : name;
        if (keys.has(key) || name.includes("\0") || value.includes("\0"))
          throw failure("服务环境键无效或重复");
        keys.add(key);
        env[name] = value;
      }
      const subprocess = execa(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env,
        extendEnv: false,
        shell: false,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        encoding: "buffer",
        buffer: false,
        stripFinalNewline: false,
        reject: false,
        cancelSignal: signal,
        killDescendants: true,
        forceKillAfterDelay: 1_000,
        windowsHide: true,
      });
      this.process = subprocess;
      this.finished = subprocess.then(
        () => this.notifyClosed(),
        () => this.notifyClosed(),
      );
      subprocess.stdout?.on("data", (chunk: Buffer) => this.read(chunk));
      subprocess.stderr?.on("data", (chunk: Buffer) => {
        this.stderrBytes += chunk.length;
        if (this.stderrBytes > MAX_STDERR_BYTES) this.fail("服务诊断输出超过上限");
      });
      subprocess.stdin?.on("error", () => this.fail("服务输入管道已关闭"));
      subprocess.stdout?.on("error", () => this.fail("服务输出管道失败"));
      subprocess.stderr?.on("error", () => this.fail("服务诊断管道失败"));
      subprocess.nodeChildProcess.once("exit", () => {
        if (!this.closing) void this.close().catch(() => {});
      });
      await new Promise<void>((resolve, reject) => {
        subprocess.nodeChildProcess.once("spawn", resolve);
        subprocess.nodeChildProcess.once("error", () => reject(failure("无法启动本地服务")));
      });
    } catch (error) {
      await this.close();
      throw error instanceof McpStdioError ? error : failure("本地服务启动失败");
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.throwIfAborted();
    const input = this.process?.stdin;
    if (!input || this.closing || !this.serialize) return Promise.reject(failure("服务未连接"));
    const bytes = Buffer.from(this.serialize(message), "utf8");
    if (
      bytes.length > MCP_MAX_FRAME_BYTES ||
      this.pendingWriteBytes + bytes.length > MAX_PENDING_WRITE_BYTES
    ) {
      this.fail("待发送消息超过上限");
      return Promise.reject(failure("待发送消息超过上限"));
    }
    this.pendingWriteBytes += bytes.length;
    return new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      this.writes.add(fail);
      input.write(bytes, (error) => {
        this.pendingWriteBytes -= bytes.length;
        this.writes.delete(fail);
        if (error) reject(failure("服务输入写入失败"));
        else resolve();
      });
    });
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    for (const reject of this.writes) reject(failure("本地服务连接已关闭"));
    this.writes.clear();
    // 在根仍存活时终止整树，避免先 EOF 退出根再丢失后代关系。
    this.process?.kill();
    let timeout: NodeJS.Timeout | undefined;
    try {
      if (this.finished) {
        await Promise.race([
          this.finished,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new McpStdioError("mcp_cleanup_failed", "本地服务未在期限内完成关闭")),
              5_000,
            );
          }),
        ]);
      }
      this.process?.stdin?.destroy();
      this.process?.stdout?.destroy();
      this.process?.stderr?.destroy();
      this.reader?.clear();
      this.process = undefined;
      for (const activity of this.activities) activity.settle();
      this.activities.length = 0;
      this.notifyClosed();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private read(chunk: Buffer): void {
    if (this.closing) return;
    try {
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > MAX_TOTAL_BYTES) throw failure("服务累计输出超过上限");
      this.decoder.decode(chunk, { stream: true });
      const lines = chunk.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
      const last = chunk.lastIndexOf(10);
      this.partialBytes = last < 0 ? this.partialBytes + chunk.length : chunk.length - last - 1;
      this.reader!.append(chunk);
      const messages: JSONRPCMessage[] = [];
      while (true) {
        const message = this.reader!.readMessage();
        if (message === null) break;
        messages.push(message);
      }
      if (messages.length !== lines) throw failure("服务输出包含非法协议行");
      for (const value of messages) this.onmessage?.(value);
    } catch {
      this.fail("服务协议消息无效或超过上限");
    }
  }

  private fail(message: string): void {
    this.onerror?.(failure(message));
    void this.close().catch(() => {});
  }

  private throwIfAborted(): void {
    if (this.controller.signal.aborted || this.options.signal?.aborted)
      throw failure("本地服务已取消或关闭");
  }

  private notifyClosed(): void {
    if (this.notified) return;
    this.notified = true;
    if (this.partialBytes) this.onerror?.(failure("服务输出包含未完成协议行"));
    try {
      this.decoder.decode();
    } catch {
      this.onerror?.(failure("服务输出包含未完成 UTF-8 字节"));
    }
    this.onclose?.();
  }
}

function failure(message: string): McpStdioError {
  return new McpStdioError("mcp_transport_error", message);
}
