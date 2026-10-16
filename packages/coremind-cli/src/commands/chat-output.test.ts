import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import type { ChatSession } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approval.js";
import { runReadlineChat } from "./chat.js";

class ControlledOutput extends EventEmitter {
  readonly chunks: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  write(text: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(text);
    this.callbacks.push(callback);
    return this.chunks.length !== 1;
  }
  stream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
  deliverAll(): void {
    for (let index = 0; index < this.callbacks.length; index++) {
      this.callbacks[index]!();
      if (index === 0) this.emit("drain");
    }
  }
}

it("readline 输出阻塞仍处理 /abort，EOF 等待全部命令输出交付", async () => {
  const input = new PassThrough();
  const output = new ControlledOutput();
  let finish!: () => void;
  const chat = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const abort = vi.fn(() => finish());
  const session = { chat, abort } as unknown as ChatSession;
  const running = runReadlineChat(session, new ApprovalQueue(false), {
    input,
    output: output.stream(),
  });
  try {
    input.write("hello\n");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    input.write("/abort\n/help\n");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    input.end();
    let completed = false;
    void running.then(() => {
      completed = true;
    });
    await setImmediate();
    expect(completed).toBe(false);
    output.deliverAll();
    await running;
    expect(output.chunks.join("")).toContain("已请求中止");
    expect(output.chunks.join("")).toContain("/follow-up");
    for (const event of ["drain", "error", "close"]) expect(output.listenerCount(event)).toBe(0);
  } finally {
    input.destroy();
  }
});

it("readline 输出错误拒绝传输并等待活动对话收尾", async () => {
  const input = new PassThrough();
  const output = new ControlledOutput();
  let finish!: () => void;
  const chat = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const abort = vi.fn();
  const session = { chat, abort } as unknown as ChatSession;
  const running = runReadlineChat(session, new ApprovalQueue(false), {
    input,
    output: output.stream(),
  });
  const rejected = expect(running).rejects.toMatchObject({ code: "output_delivery_failed" });
  try {
    input.write("hello\n");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    let completed = false;
    void running.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    output.emit("error", new Error("Bearer private-error"));
    expect(abort).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await rejected;
    expect(output.chunks).toHaveLength(1);
    expect(output.listenerCount("error")).toBe(1);
    output.callbacks[0]!();
    await setImmediate();
    for (const event of ["drain", "error", "close"]) expect(output.listenerCount(event)).toBe(0);
  } finally {
    finish?.();
    input.destroy();
  }
});
