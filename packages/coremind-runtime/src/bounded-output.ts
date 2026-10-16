import { setImmediate } from "node:timers/promises";
import { CoreMindError } from "./errors.js";

const MAX_PENDING_MESSAGES = 1_024;
// shortcut: 预算仅覆盖已编码队列与在飞消息；需要限制上游生成内存时再接异步背压。
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;
const FLUSH_TIMEOUT_MS = 10_000;

export interface BoundedOutput {
  write(text: string, droppable?: boolean): boolean;
  flush(): Promise<void>;
  close(): Promise<void>;
  fail(): void;
  readonly failure: Error | undefined;
}

interface PendingWrite {
  bytes: number;
  returned: boolean;
  callbackDone: boolean;
  needsDrain: boolean;
  drained: boolean;
}

/** 仅供内部 CLI/Worker 传输复用；流及其最终关闭始终归调用者所有。 */
export function createBoundedOutput(
  output: NodeJS.WritableStream,
  options: {
    onFailure: (error: Error) => void;
    maxPendingBytes?: number;
  },
): BoundedOutput {
  const maxBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("输出字节预算必须是正安全整数");
  }
  const queue: Array<{ text: string; bytes: number }> = [];
  let pendingBytes = 0;
  let inFlight: PendingWrite | undefined;
  let physicalWrite: PendingWrite | undefined;
  let streamClosed = false;
  let guardSettling: Promise<void> | undefined;
  let failure: Error | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let pumping = false;
  let flushing:
    | {
        promise: Promise<void>;
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const detachErrorGuard = () => {
    output.removeListener("error", onError);
    output.removeListener("close", onClose);
  };
  const settleErrorGuard = (): Promise<void> => {
    // 逻辑关闭不等待不合作的物理回调；只保留常数大小护栏至该写入收敛。
    if (physicalWrite && !streamClosed) return Promise.resolve();
    if (streamClosed) {
      detachErrorGuard();
      return Promise.resolve();
    }
    guardSettling ??= (async () => {
      if (failure) await setImmediate();
      if (!physicalWrite) detachErrorGuard();
    })();
    return guardSettling;
  };
  const finishFlush = (error?: Error) => {
    if (!flushing) return;
    const current = flushing;
    flushing = undefined;
    clearTimeout(current.timer);
    if (error) current.reject(error);
    else current.resolve();
  };
  const fail = (message: string) => {
    if (failure) return;
    // 不保留原消息或外部错误；故障后立即释放队列，迟到回调不能复活写入。
    failure = new CoreMindError("output_delivery_failed", message);
    queue.length = 0;
    inFlight = undefined;
    pendingBytes = 0;
    finishFlush(failure);
    options.onFailure(failure);
  };
  const complete = (current: PendingWrite) => {
    if (closed || failure || inFlight !== current || !current.returned || !current.callbackDone)
      return;
    if (current.needsDrain && !current.drained) return;
    inFlight = undefined;
    pendingBytes -= current.bytes;
    pump();
  };
  const pump = () => {
    if (closed || failure || pumping) return;
    pumping = true;
    try {
      while (!inFlight && queue.length > 0 && !closed && !failure) {
        const item = queue.shift()!;
        const current: PendingWrite = {
          bytes: item.bytes,
          returned: false,
          callbackDone: false,
          needsDrain: false,
          drained: false,
        };
        inFlight = current;
        physicalWrite = current;
        try {
          const accepted = output.write(item.text, (error?: Error | null) => {
            if (physicalWrite === current) physicalWrite = undefined;
            if (closed) void settleErrorGuard();
            if (closed || failure || inFlight !== current) return;
            if (error) {
              fail("输出写入失败");
              return;
            }
            current.callbackDone = true;
            complete(current);
          });
          current.needsDrain = !accepted;
          current.returned = true;
          complete(current);
        } catch {
          fail("输出写入失败");
        }
      }
    } finally {
      pumping = false;
    }
    if (!failure && pendingBytes === 0) finishFlush();
  };
  const onDrain = () => {
    if (!inFlight || closed || failure) return;
    inFlight.drained = true;
    complete(inFlight);
  };
  const onError = () => {
    fail("输出流发生错误");
  };
  const onClose = () => {
    streamClosed = true;
    physicalWrite = undefined;
    fail("输出流已关闭");
    if (closed) detachErrorGuard();
  };
  output.on("drain", onDrain);
  output.on("error", onError);
  output.on("close", onClose);

  return {
    get failure() {
      return failure;
    },
    write(text, droppable = false) {
      if (closed || failure) return false;
      if (text.length === 0) return true;
      const bytes = Buffer.byteLength(text, "utf8");
      if (bytes > maxBytes) {
        fail("单条输出超过传输字节预算");
        return false;
      }
      if (
        pendingBytes + bytes > maxBytes ||
        queue.length + (inFlight ? 1 : 0) >= MAX_PENDING_MESSAGES
      ) {
        if (!droppable) fail("待交付输出超过传输预算");
        return false;
      }
      pendingBytes += bytes;
      queue.push({ text, bytes });
      pump();
      return failure === undefined && !closed;
    },
    flush() {
      if (failure) return Promise.reject(failure);
      if (closed)
        return Promise.reject(new CoreMindError("output_delivery_failed", "输出交付器已关闭"));
      if (pendingBytes === 0) return Promise.resolve();
      if (flushing) return flushing.promise;
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const timer = setTimeout(() => fail("输出交付等待超时"), FLUSH_TIMEOUT_MS);
      flushing = { promise, resolve, reject, timer };
      return promise;
    },
    fail() {
      if (!closed) fail("输出内容无法交付");
    },
    close() {
      if (closing) return closing;
      closed = true;
      if (pendingBytes > 0) fail("输出交付器关闭时仍有未交付内容");
      output.removeListener("drain", onDrain);
      closing = settleErrorGuard();
      return closing;
    },
  };
}
