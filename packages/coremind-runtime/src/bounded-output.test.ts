import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { setImmediate as yieldOutputTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createBoundedOutput } from "./bounded-output.js";

class ControlledOutput extends EventEmitter {
  readonly writes: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  accepts = true;
  immediate = false;
  throws = false;

  write(text: string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(text);
    this.callbacks.push(callback);
    if (this.throws) throw new Error("Bearer private-write-error");
    if (this.immediate) callback();
    return this.accepts;
  }

  stream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
  complete(index: number, error?: Error) {
    this.callbacks[index]!(error);
  }
}

function expectDetached(output: EventEmitter) {
  for (const event of ["drain", "error", "close"]) expect(output.listenerCount(event)).toBe(0);
}

describe("有界输出交付", () => {
  it("UTF8 精确边界包含在飞字节，flush 等到最后一个回调", async () => {
    const output = new ControlledOutput();
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output.stream(), { maxPendingBytes: 6, onFailure });
    try {
      expect(writer.write("你")).toBe(true);
      expect(writer.write("好")).toBe(true);
      expect(writer.write("a", true)).toBe(false);
      expect(output.writes).toEqual(["你"]);
      expect(onFailure).not.toHaveBeenCalled();
      const flushing = writer.flush();
      expect(writer.flush()).toBe(flushing);
      let delivered = false;
      void flushing.then(
        () => {
          delivered = true;
        },
        () => {},
      );
      output.complete(0);
      expect(output.writes).toEqual(["你", "好"]);
      expect(writer.write("a")).toBe(true);
      output.complete(1);
      await Promise.resolve();
      expect(delivered).toBe(false);
      expect(output.writes).toEqual(["你", "好", "a"]);
      output.complete(2);
      await flushing;
      expect(delivered).toBe(true);
    } finally {
      await writer.close();
    }
    expectDetached(output);
  });

  it.each(["callback-first", "drain-first"] as const)(
    "false 后 %s 仍需两个信号才推进",
    async (order) => {
      const output = new ControlledOutput();
      output.accepts = false;
      const writer = createBoundedOutput(output.stream(), { onFailure: vi.fn() });
      try {
        writer.write("first");
        writer.write("last");
        const flushing = writer.flush();
        output.accepts = true;
        if (order === "callback-first") output.complete(0);
        else output.emit("drain");
        expect(output.writes).toEqual(["first"]);
        if (order === "callback-first") output.emit("drain");
        else output.complete(0);
        expect(output.writes).toEqual(["first", "last"]);
        output.complete(1);
        await flushing;
      } finally {
        await writer.close();
      }
    },
  );

  it("同步回调不重入写入或误扣字节，空字符串不占条数", async () => {
    const output = new ControlledOutput();
    output.immediate = true;
    const writer = createBoundedOutput(output.stream(), { maxPendingBytes: 1, onFailure: vi.fn() });
    try {
      for (let index = 0; index < 2_000; index++) {
        expect(writer.write("")).toBe(true);
        expect(writer.write("a")).toBe(true);
      }
      await writer.flush();
      expect(output.writes).toHaveLength(2_000);
      expect(writer.failure).toBeUndefined();
    } finally {
      await writer.close();
    }
  });

  it("条数上限包括在飞消息，可重放消息可丢，关键消息不能静默丢", async () => {
    const output = new ControlledOutput();
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output.stream(), { maxPendingBytes: 2_048, onFailure });
    try {
      for (let index = 0; index < 1_024; index++) expect(writer.write("a")).toBe(true);
      expect(writer.write("replayable", true)).toBe(false);
      expect(writer.failure).toBeUndefined();
      expect(writer.write("required")).toBe(false);
      await expect(writer.flush()).rejects.toThrow("传输预算");
      expect(onFailure).toHaveBeenCalledOnce();
      expect(output.writes).toHaveLength(1);
      output.complete(0);
      expect(writer.write("late")).toBe(false);
      expect(output.writes).toHaveLength(1);
    } finally {
      await writer.close();
    }
  });

  it("单条多字节超限立即失败，不写入且不泄漏正文", async () => {
    const output = new ControlledOutput();
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output.stream(), { maxPendingBytes: 3, onFailure });
    try {
      expect(writer.write("私密", true)).toBe(false);
      await expect(writer.flush()).rejects.toThrow("单条输出");
      expect(String(writer.failure)).not.toContain("私密");
      expect(writer.failure).toMatchObject({ code: "output_delivery_failed" });
      expect(output.writes).toEqual([]);
      expect(writer.write("a")).toBe(false);
      expect(onFailure).toHaveBeenCalledOnce();
    } finally {
      await writer.close();
    }
  });

  it.each(["throw", "callback", "error", "close"] as const)(
    "%s 只通知一次失败且迟到回调不复活",
    async (source) => {
      const output = new ControlledOutput();
      const onFailure = vi.fn();
      const writer = createBoundedOutput(output.stream(), { onFailure });
      try {
        output.throws = source === "throw";
        writer.write("private-body");
        const rejected = expect(writer.flush()).rejects.toThrow("输出");
        if (source === "callback") output.complete(0, new Error("Bearer callback-secret"));
        if (source === "error") output.emit("error", new Error("Bearer event-secret"));
        if (source === "close") output.emit("close");
        await rejected;
        output.emit("error", new Error("Bearer duplicate-secret"));
        output.emit("close");
        output.complete(0);
        expect(writer.write("late")).toBe(false);
        expect(output.writes).toHaveLength(1);
        expect(onFailure).toHaveBeenCalledOnce();
        expect(String(writer.failure)).not.toMatch(/private-body|Bearer|secret/);
      } finally {
        await writer.close();
      }
      expectDetached(output);
    },
  );

  it("flush 超时有界、共享等待者失败且定时器和监听器可释放", async () => {
    vi.useFakeTimers();
    const output = new ControlledOutput();
    output.accepts = false;
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output.stream(), { onFailure });
    try {
      writer.write("blocked");
      const flushing = writer.flush();
      expect(writer.flush()).toBe(flushing);
      const rejected = expect(flushing).rejects.toThrow("等待超时");
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(onFailure).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await writer.close();
      expect(output.listenerCount("error")).toBe(1);
      expect(output.listenerCount("close")).toBe(1);
      output.complete(0);
      await yieldOutputTurn();
      expectDetached(output);
      expect(writer.write("late")).toBe(false);
    } finally {
      await writer.close();
      vi.useRealTimers();
    }
  });

  it("close 拒绝未交付的 flush 并清理监听，不等同于交付成功", async () => {
    const output = new ControlledOutput();
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output.stream(), { onFailure });
    writer.write("pending");
    const rejected = expect(writer.flush()).rejects.toThrow("未交付");
    await writer.close();
    await writer.close();
    await rejected;
    expect(onFailure).toHaveBeenCalledOnce();
    expect(output.listenerCount("error")).toBe(1);
    output.complete(0);
    await yieldOutputTurn();
    expectDetached(output);
    expect(output.writes).toHaveLength(1);
  });

  it("真实 Writable 的回调错误和后续 error/close 只形成一个失败", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("Bearer native-secret"));
      },
    });
    const closed = new Promise<void>((resolve) => output.once("close", resolve));
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output, { onFailure });
    try {
      writer.write("private-body");
      await expect(writer.flush()).rejects.toThrow("输出");
      await closed;
      expect(onFailure).toHaveBeenCalledOnce();
      expect(String(writer.failure)).not.toContain("native-secret");
    } finally {
      await writer.close();
      output.destroy();
    }
    expectDetached(output);
  });

  it("成功 close 只清自身监听，不结束或销毁调用者的真实流", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const writer = createBoundedOutput(output, { onFailure: vi.fn() });
    try {
      writer.write("ok");
      await writer.flush();
      await writer.close();
      expect(output.writableEnded).toBe(false);
      expect(output.destroyed).toBe(false);
      expectDetached(output);
      await expect(writer.flush()).rejects.toThrow("已关闭");
    } finally {
      await writer.close();
      output.destroy();
    }
  });

  it("回调错误后立即 close 仍吸收该轮迟到的原生 error", async () => {
    const output = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) {
        callback(new Error("Bearer late-secret"));
      },
    });
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output, { onFailure });
    try {
      writer.write("private-body");
      await expect(writer.flush()).rejects.toMatchObject({ code: "output_delivery_failed" });
      const closing = writer.close();
      expect(writer.close()).toBe(closing);
      await closing;
      expect(onFailure).toHaveBeenCalledOnce();
      expectDetached(output);
    } finally {
      await writer.close();
      output.destroy();
    }
  });

  it("调用方编码失败可锁存类型化失败且后续正文不再排队", async () => {
    const output = new ControlledOutput();
    const onFailure = vi.fn();
    const writer = createBoundedOutput(output.stream(), { onFailure });
    try {
      writer.fail();
      writer.fail();
      expect(writer.write("late-body")).toBe(false);
      await expect(writer.flush()).rejects.toMatchObject({ code: "output_delivery_failed" });
      expect(onFailure).toHaveBeenCalledOnce();
      expect(output.writes).toEqual([]);
    } finally {
      await writer.close();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "拒绝无效字节预算 %s",
    (maxPendingBytes) => {
      const output = new ControlledOutput();
      expect(() =>
        createBoundedOutput(output.stream(), { maxPendingBytes, onFailure: vi.fn() }),
      ).toThrow("正安全整数");
      expectDetached(output);
    },
  );

  it("预算失败后 close 仍保护尚未返回的自有 write callback", async () => {
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    const output = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) {
        releaseWrite = callback;
      },
    });
    const fallback = vi.fn();
    output.on("error", fallback);
    const failed = vi.fn();
    const writer = createBoundedOutput(output, { maxPendingBytes: 1, onFailure: failed });
    let released = false;
    try {
      expect(writer.write("a")).toBe(true);
      expect(writer.write("b")).toBe(false);
      await expect(writer.flush()).rejects.toMatchObject({ code: "output_delivery_failed" });
      await writer.close();
      // 排除测试自己的 fallback；原写未回调时 helper 仍须留一个常数护栏。
      expect(output.listenerCount("error") - 1).toBe(1);
      releaseWrite!(new Error("Bearer held-write-secret"));
      released = true;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fallback).toHaveBeenCalledOnce();
      expect(output.listenerCount("error")).toBe(1);
      expect(failed).toHaveBeenCalledOnce();
      expect(String(writer.failure)).not.toContain("held-write-secret");
      expect(output.writableEnded).toBe(false);
      expect(output.destroyed).toBe(false);
    } finally {
      // 失败断言也释放自己持有的真实 callback；fallback 避免红例污染 suite。
      if (!released) releaseWrite?.(new Error("test-only cleanup"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await writer.close();
      output.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      output.off("error", fallback);
    }
  });
});
