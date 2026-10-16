import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { execa, type Subprocess } from "execa";
import { McpStdioError } from "./mcp-stdio-error.js";
import { WINDOWS_MCP_JOB_SCRIPT } from "./windows-mcp-job-script.js";
import { WINDOWS_MCP_SERVICE_SHA256 } from "./windows-mcp-service-identity.js";

const MAX_CONTROL_BYTES = 1024 * 1024;
type ManagedProcess = Subprocess<{ encoding: "buffer"; buffer: false; reject: false }>;
export interface WindowsMcpJob {
  process: ManagedProcess;
  ready: Promise<void>;
  close(): Promise<void>;
}
interface Endpoint {
  name: string;
  socket?: Socket;
  close(): Promise<void>;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const transportFailure = () => new McpStdioError("mcp_transport_error", "本地服务控制连接失败");
const cleanupFailure = () => new McpStdioError("mcp_cleanup_failed", "本地服务未在期限内完成关闭");

function frame(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > MAX_CONTROL_BYTES) throw transportFailure();
  return bytes;
}
function message(value: unknown, type: string, extra: readonly string[] = []): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === type &&
    Object.keys(value).every((key) => key === "type" || extra.includes(key))
  );
}

async function endpoint(
  prefix: "owner" | "service",
  onConnect: (socket: Socket) => void,
  onFrame: (value: unknown) => void,
  onEnd: () => void,
  onFailure: () => void,
): Promise<Endpoint> {
  const name = `coremind-mcp-${prefix}-${randomUUID()}`;
  const closed = deferred<void>();
  let accepted = false;
  let stopped: Promise<void> | undefined;
  const server: Server = createServer((socket) => {
    if (accepted) {
      socket.destroy();
      return;
    }
    accepted = true;
    result.socket = socket;
    // 第一条连接取得后停止接受新连接，管道名从不接收外部配置。
    server.close();
    let pending = Buffer.alloc(0);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    socket.on("data", (chunk: Buffer) => {
      try {
        if (pending.length + chunk.length > MAX_CONTROL_BYTES) throw transportFailure();
        pending = Buffer.concat([pending, chunk]);
        while (true) {
          const end = pending.indexOf(10);
          if (end < 0) break;
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          onFrame(JSON.parse(decoder.decode(line)) as unknown);
        }
      } catch {
        socket.destroy();
        onFailure();
      }
    });
    socket.once("error", onFailure);
    socket.once("close", () => {
      if (pending.length) onFailure();
      onEnd();
    });
    try {
      onConnect(socket);
    } catch {
      socket.destroy();
      onFailure();
    }
  });
  const result: Endpoint = {
    name,
    close() {
      stopped ??= (async () => {
        result.socket?.destroy();
        if (server.listening) server.close();
        await closed.promise;
      })();
      return stopped;
    },
  };
  server.once("close", () => closed.resolve());
  server.on("error", onFailure);
  try {
    await new Promise<void>((resolve, reject) => {
      const error = () => reject(transportFailure());
      server.once("error", error);
      server.listen(`\\\\.\\pipe\\${name}`, () => {
        server.removeListener("error", error);
        resolve();
      });
    });
  } catch {
    server.close(() => {});
    throw transportFailure();
  }
  return result;
}

/** Windows 私有 Job owner；业务参数及凭据只经独立本机控制管道交付。 */
export async function launchWindowsMcpJob(
  options: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
  },
  signal: AbortSignal,
): Promise<WindowsMcpJob> {
  const startupTrace = Reflect.get(globalThis, Symbol.for("coremind.mcpStartup.capture"))?.(signal);
  startupTrace?.("job_prepare_begin");
  if (process.platform !== "win32") throw transportFailure();
  const launcher = new URL("./vendor/windows-mcp/service.mjs", import.meta.url);
  try {
    if (
      createHash("sha256")
        .update(await readFile(launcher))
        .digest("hex") !== WINDOWS_MCP_SERVICE_SHA256
    )
      throw transportFailure();
  } catch {
    throw transportFailure();
  }
  const hostEnv: Record<string, string> = {};
  for (const name of ["SystemRoot", "windir", "PATH", "PATHEXT", "ComSpec", "TEMP", "TMP"]) {
    const entry = Object.entries(process.env).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    if (entry?.[1] !== undefined) hostEnv[name] = entry[1];
  }
  const windowsDirectory = [hostEnv.SystemRoot, hostEnv.windir].find(
    (value) => value && /^[a-z]:[/\\]/iu.test(path.win32.parse(value).root),
  );
  if (!windowsDirectory) throw transportFailure();
  let serviceFrame: Buffer | undefined = frame({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: { ...options.env },
  });
  const ready = deferred<void>();
  const ownerClosed = deferred<void>();
  const setupDone = deferred<void>();
  let owner: Endpoint | undefined;
  let service: Endpoint | undefined;
  let helper: ManagedProcess | undefined;
  let helperFinished: Promise<boolean> | undefined;
  let closing: Promise<void> | undefined;
  let ownerReady = false;
  let serviceReady = false;
  let configurationSent = false;
  let ownerInitialized = false;
  let firstWasCancel = false;
  let provedClosed = false;
  let serviceExited = false;
  let controlFailed = false;
  const send = (socket: Socket, bytes: Buffer) => {
    if (socket.destroyed || socket.writableLength + bytes.length > MAX_CONTROL_BYTES) {
      fail();
      return;
    }
    socket.write(bytes, (error) => {
      if (error) fail();
    });
  };
  const configureService = () => {
    if (!ownerReady || !service?.socket || configurationSent || closing || signal.aborted) return;
    configurationSent = true;
    const bytes = serviceFrame!;
    serviceFrame = undefined;
    send(service.socket, bytes);
  };
  const finishReady = () => {
    if (ownerReady && serviceReady && !closing && !signal.aborted) ready.resolve();
  };
  function fail() {
    controlFailed = true;
    ready.reject(transportFailure());
    void close().catch(() => {});
  }
  async function closeOwned(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const endEndpoints = async () => {
      await Promise.all([owner?.close(), service?.close()]);
    };
    try {
      await Promise.race([
        (async () => {
          await setupDone.promise;
          if (owner?.socket && ownerInitialized && !firstWasCancel && !provedClosed)
            send(owner.socket, frame({ close: true }));
          if (helper?.pid !== undefined) {
            await ownerClosed.promise;
            if (!(await helperFinished)) throw cleanupFailure();
          } else if (helperFinished) await helperFinished;
          await endEndpoints();
          if (controlFailed) throw cleanupFailure();
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(cleanupFailure()), 5_000);
        }),
      ]);
    } catch {
      // 失败后仍销毁本机控制连接；缺少 Job active=0 证明时不能假装成功。
      helper?.nodeChildProcess.kill("SIGKILL");
      void endEndpoints().catch(() => {});
      throw cleanupFailure();
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      serviceFrame = undefined;
    }
  }
  function close(): Promise<void> {
    if (!closing) {
      // 先拒绝 ready，Transport 的启动等待才能退出；关闭状态先于任何异步动作登记。
      ready.reject(transportFailure());
      closing = Promise.resolve().then(closeOwned);
    }
    return closing;
  }
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    owner = await endpoint(
      "owner",
      (socket) => {
        startupTrace?.("owner_socket_connected");
        firstWasCancel = Boolean(closing || signal.aborted);
        ownerInitialized = true;
        send(
          socket,
          firstWasCancel
            ? frame({ cancel: true })
            : frame({
                nodePath: process.execPath,
                launcherPath: fileURLToPath(launcher),
                servicePipeName: service!.name,
                cwd: options.cwd,
                hostEnv,
              }),
        );
      },
      (value) => {
        if (message(value, "job_ready") && !ownerReady && !provedClosed) {
          startupTrace?.("owner_job_ready");
          ownerReady = true;
          configureService();
          finishReady();
        } else if (
          message(value, "closed", ["activeProcesses"]) &&
          (value as { activeProcesses?: unknown }).activeProcesses === 0 &&
          !provedClosed
        ) {
          provedClosed = true;
          ownerClosed.resolve();
          void close().catch(() => {});
        } else fail();
      },
      () => {
        if (!provedClosed) fail();
      },
      fail,
    );
    startupTrace?.("owner_listen_ready");
    service = await endpoint(
      "service",
      (socket) => {
        startupTrace?.("service_socket_connected");
        if (closing || signal.aborted) socket.end();
        else configureService();
      },
      (value) => {
        if (message(value, "ready") && configurationSent && !serviceReady && !serviceExited) {
          startupTrace?.("service_ready");
          serviceReady = true;
          finishReady();
        } else if (message(value, "exit") && serviceReady && !serviceExited) {
          serviceExited = true;
          void close().catch(() => {});
        } else if (message(value, "error")) {
          ready.reject(transportFailure());
          void close().catch(() => {});
        } else fail();
      },
      () => {
        if (!serviceExited && !closing) fail();
      },
      fail,
    );
    startupTrace?.("service_listen_ready");
    const helperOptions = {
      cwd: options.cwd,
      env: { ...hostEnv, COREMIND_MCP_OWNER_PIPE: owner.name },
      extendEnv: false,
      shell: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      encoding: "buffer",
      buffer: false,
      stripFinalNewline: false,
      reject: false,
      windowsHide: true,
      cleanup: false,
      killDescendants: false,
    } as const;
    helper = execa(
      path.win32.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_MCP_JOB_SCRIPT, "utf16le").toString("base64"),
      ],
      helperOptions,
    );
    if (startupTrace)
      helper.nodeChildProcess.once("spawn", () => startupTrace("helper_spawn_event"));
    startupTrace?.("helper_spawned");
    if (startupTrace) helper.stderr.on("data", startupTrace.stderr);
    helperFinished = helper.then(
      (result) => {
        if (!closing) void close().catch(() => {});
        return !result.failed && result.exitCode === 0;
      },
      () => {
        fail();
        return false;
      },
    );
    setupDone.resolve();
    return { process: helper, ready: ready.promise, close };
  } catch {
    setupDone.resolve();
    await close().catch(() => {});
    throw transportFailure();
  }
}
