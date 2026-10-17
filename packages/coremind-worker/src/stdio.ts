#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CoreMindError } from "coremind-ai";
import { type BoundedOutput, createBoundedOutput } from "coremind-ai/internal";
import { createErrorResponse } from "coremind-protocol";
import { emitStartupDiagnostic, WorkerServer } from "./server.js";

export interface StdioSenderOptions {
  maxPendingBytes?: number;
  onFailure?: (error: Error) => void;
}

export interface StdioSender extends Pick<BoundedOutput, "flush" | "close" | "failure" | "fail"> {
  send(message: unknown): void;
}

/** 关键响应交付失败必须显式收尾；预算不足时仅丢弃可重放的 live event。 */
export function createStdioSender(
  output: NodeJS.WritableStream,
  options: StdioSenderOptions = {},
): StdioSender {
  let closed = false;
  const writer = createBoundedOutput(output, {
    maxPendingBytes: options.maxPendingBytes,
    onFailure: options.onFailure ?? (() => {}),
  });
  return {
    get failure() {
      return writer.failure;
    },
    flush: () => writer.flush(),
    close: () => {
      closed = true;
      return writer.close();
    },
    fail: () => writer.fail(),
    send(message) {
      if (closed || writer.failure) return;
      try {
        writer.write(`${JSON.stringify(message)}\n`, isLiveEvent(message));
      } catch {
        writer.fail();
      }
    },
  };
}

function isLiveEvent(message: unknown): boolean {
  const notification = message as {
    method?: unknown;
    params?: { event?: { type?: unknown } };
  } | null;
  return (
    message !== null &&
    typeof message === "object" &&
    notification?.method === "event" &&
    notification.params?.event?.type !== "approval_required"
  );
}

/** 一行一个 JSON-RPC 消息；普通背压期间仍处理输入，硬失败后等待一次统一收尾。 */
export function runStdioWorker(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  emitStartupDiagnostic("stdio-enter");
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let finishing = false;
  const pending = new Set<Promise<void>>();
  const sender = createStdioSender(output, { onFailure: () => queueMicrotask(finish) });
  const server = new WorkerServer({ send: (message) => sender.send(message) });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  function finish(): void {
    if (finishing) return;
    finishing = true;
    lines.removeListener("line", onLine);
    lines.close();
    const finished = (async () => {
      let deadlineFailure: CoreMindError | undefined;
      try {
        const shutdown = await server.shutdown().then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            (async () => {
              await Promise.all(pending);
              if (sender.failure) throw sender.failure;
              if ("error" in shutdown) throw shutdown.error;
              if (!shutdown.result.quiescent) {
                throw new CoreMindError("worker_closed", "Worker 收尾未达到静止");
              }
              await sender.flush();
            })(),
            new Promise<never>((_resolve, rejectPending) => {
              timer = setTimeout(() => {
                deadlineFailure = new CoreMindError(
                  "output_delivery_failed",
                  pending.size > 0
                    ? "输出交付等待超时；已接收操作未全部收尾，需宿主处置"
                    : "输出交付等待超时",
                );
                sender.fail();
                rejectPending(deadlineFailure);
              }, 10_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        throw deadlineFailure ?? sender.failure ?? error;
      } finally {
        await sender.close();
      }
    })();
    void finished.then(resolve, reject);
  }

  function onLine(line: string): void {
    if (finishing || sender.failure || line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      sender.send(
        createErrorResponse(
          "invalid",
          -32_700,
          `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
          "parse_error",
        ),
      );
      return;
    }
    // 跟踪最终 RPC 响应，但输入循环不能等待长运行，否则控制请求会被饿死。
    const initializing =
      typeof value === "object" &&
      value !== null &&
      "method" in value &&
      value.method === "initialize";
    if (initializing) emitStartupDiagnostic("initialize-line");
    const operation = server
      .handle(value)
      .then(
        (response) => {
          if (initializing) emitStartupDiagnostic("initialize-response-created");
          sender.send(response);
          if (initializing) emitStartupDiagnostic("initialize-response-enqueued");
        },
        () => sender.fail(),
      )
      .finally(() => pending.delete(operation));
    pending.add(operation);
  }

  lines.on("line", onLine);
  lines.once("close", finish);
  emitStartupDiagnostic("stdio-ready");
  return completion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runStdioWorker();
  } catch (error) {
    console.error(
      error instanceof CoreMindError
        ? `${error.code}: ${error.message}`
        : "worker_closed: Worker stdio 收尾失败",
    );
    process.exitCode = 1;
  }
}
