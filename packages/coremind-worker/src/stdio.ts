#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createErrorResponse } from "coremind-protocol";
import { WorkerServer } from "./server.js";

/** 一行一个 JSON-RPC 消息；stdout 只输出协议，诊断信息写 stderr。 */
export function runStdioWorker(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const send = (message: unknown) => {
    output.write(`${JSON.stringify(message)}\n`);
  };
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
