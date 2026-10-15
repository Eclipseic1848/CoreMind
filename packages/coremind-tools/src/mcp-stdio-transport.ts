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
import { McpStdioError } from "./mcp-stdio-error.js";
import { probeProcessTreeTermination } from "./process-runner.js";
import { launchWindowsMcpJob, type WindowsMcpJob } from "./windows-mcp-job.js";

export { McpStdioError } from "./mcp-stdio-error.js";

export const MCP_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_WRITE_BYTES = 1024 * 1024;
type ManagedProcess = Subprocess<{ encoding: "buffer"; buffer: false; reject: false }>;

/** 私有传输只管理本次连接；权限准入由调用方在 connect 前完成。 */
export class McpStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  environmentSummary: McpStdioDomainSummary | undefined;
  private process?: ManagedProcess;
  private windowsJob?: WindowsMcpJob;
  private reader?: ReadBuffer;
  private serialize?: typeof import("@modelcontextprotocol/client").serializeMessage;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly controller = new AbortController();
  private readonly activities: ExecutionEnvironmentActivity[] = [];
  private readonly writes = new Set<(error: Error) => void>();
  private finished?: Promise<void>;
  private starting?: Promise<void>;
  private removeCancellationListener?: () => void;
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
    // 启动阶段独立于异常关闭，避免 close 等待 start、start 又等待 close 的互锁。
    this.starting = this.startOwned();
    try {
      await this.starting;
    } catch (error) {
      await this.close();
      throw error instanceof McpStdioError ? error : failure("本地服务启动失败");
    }
  }

  private async startOwned(): Promise<void> {
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
    this.activities.push(
      domain.beginActivity({ id: `mcp-process:${randomUUID()}`, kind: "process" }),
    );
    const signal = AbortSignal.any([
      this.controller.signal,
      ...this.activities.map((activity) => activity.signal),
      ...(this.options.signal ? [this.options.signal] : []),
    ]);
    const closeOnAbort = () => {
      void this.close().catch(() => {});
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    this.removeCancellationListener = () => signal.removeEventListener("abort", closeOnAbort);
    if (signal.aborted) throw failure("连接启动前已取消");
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
    if (process.platform === "win32") {
      this.windowsJob = await launchWindowsMcpJob(
        {
          command: this.options.command,
          args: this.options.args,
          cwd: this.options.cwd,
          env,
        },
        signal,
      );
    }
    const spawnOptions = {
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
      killDescendants: true,
      forceKillAfterDelay: 1_000,
      windowsHide: true,
    } as const;
    const subprocess =
      this.windowsJob?.process ?? execa(this.options.command, [...this.options.args], spawnOptions);
    this.process = subprocess;
    this.finished = subprocess.then(
      () => {},
      () => {},
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
    await (this.windowsJob?.ready ??
      new Promise<void>((resolve, reject) => {
        subprocess.nodeChildProcess.once("spawn", resolve);
        subprocess.nodeChildProcess.once("error", () => reject(failure("无法启动本地服务")));
      }));
    if (signal.aborted) throw failure("连接启动前已取消");
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
    // 先登记唯一 owner，再触发自身 abort；同步取消 listener 只能取得同一个 Promise。
    this.closing ??= Promise.resolve().then(() => this.closeOwned());
    return this.closing;
  }

  private async closeOwned(): Promise<void> {
    this.controller.abort();
    for (const reject of this.writes) reject(failure("本地服务连接已关闭"));
    this.writes.clear();
    const deadline = performance.now() + 5_000;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const joinOwned = async () => {
        await this.starting?.catch(() => {});
        const subprocess = this.process;
        if (!subprocess) return;
        if (performance.now() >= deadline) throw cleanupFailure();
        if (this.windowsJob) {
          await Promise.all([this.windowsJob.close(), this.finished]);
        } else {
          if (process.platform !== "win32") subprocess.kill();
          await this.finished;
        }
      };
      await Promise.race([
        joinOwned(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(cleanupFailure()), 5_000);
        }),
      ]);
      this.process?.stdin?.destroy();
      this.process?.stdout?.destroy();
      this.process?.stderr?.destroy();
      this.reader?.clear();
      this.process = undefined;
      this.windowsJob = undefined;
      for (const activity of this.activities) activity.settle();
      this.activities.length = 0;
      this.notifyClosed();
    } catch {
      // 失败不结算活动，也不透出命令、环境或系统诊断；上层静止门仍然保持关闭。
      throw cleanupFailure();
    } finally {
      if (timeout) clearTimeout(timeout);
      this.removeCancellationListener?.();
      this.removeCancellationListener = undefined;
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

function cleanupFailure(): McpStdioError {
  return new McpStdioError("mcp_cleanup_failed", "本地服务未在期限内完成关闭");
}

function failure(message: string): McpStdioError {
  return new McpStdioError("mcp_transport_error", message);
}
