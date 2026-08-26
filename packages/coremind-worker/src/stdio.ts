#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createErrorResponse } from "coremind-protocol";
import { WorkerServer } from "./server.js";

export interface StdioSenderOptions {
  maxQueuedMessages?: number;
}

/** 遵守 Writable 背压；只允许在队列满时丢弃可重放的 live event。 */
export function createStdioSender(
  output: NodeJS.WritableStream,
  options: StdioSenderOptions = {},
): (message: unknown) => void {
  const maxQueuedMessages = options.maxQueuedMessages ?? 1_024;
  if (!Number.isInteger(maxQueuedMessages) || maxQueuedMessages < 1) {
    throw new Error("maxQueuedMessages 必须是正整数");
  }
  const queue: Array<{ line: string; droppable: boolean }> = [];
  let blocked = false;
  let closed = false;

  const flush = (): void => {
    if (closed) return;
    blocked = false;
    while (queue.length > 0 && !blocked) {
      const next = queue.shift()!;
      try {
        blocked = !output.write(next.line);
      } catch {
        closed = true;
        queue.length = 0;
        return;
      }
      if (blocked) output.once("drain", flush);
    }
  };

  return (message: unknown): void => {
    if (closed) return;
    const item = {
      line: `${JSON.stringify(message)}\n`,
      droppable: isLiveEvent(message),
    };
    if (!blocked && queue.length === 0) {
      queue.push(item);
      flush();
      return;
    }
    if (item.droppable && queue.length >= maxQueuedMessages) return;
    queue.push(item);
  };
}

function isLiveEvent(message: unknown): boolean {
  return (
    message !== null &&
    typeof message === "object" &&
    (message as { method?: unknown }).method === "event"
  );
}

/** 一行一个 JSON-RPC 消息；stdout 只输出协议，诊断信息写 stderr。 */
export function runStdioWorker(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const send = createStdioSender(output);
  const server = new WorkerServer({ send });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      send(
        createErrorResponse(
          "invalid",
          -32_700,
          `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
          "parse_error",
        ),
      );
      return;
    }
    server.accept(value);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioWorker();
}
