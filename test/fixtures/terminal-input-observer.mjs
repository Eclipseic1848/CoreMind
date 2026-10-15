import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

// 只观察 Ink 原本执行的 read；不新增输入监听、不额外读取或伪造 TTY。
const destination = process.env.COREMIND_PTY_INPUT_LOG;
if (!destination) throw new Error("真实 PTY 观察缺少测试记录路径");
let sequence = 0;
const record = (value) => appendFileSync(destination, `${JSON.stringify(value)}\n`, "utf8");
record({
  type: "terminal",
  pid: process.pid,
  isTTY: process.stdin.isTTY === true,
  cols: process.stdout.columns,
  rows: process.stdout.rows,
});
const originalSetRawMode = process.stdin.setRawMode;
process.stdin.setRawMode = function (enabled) {
  const result = Reflect.apply(originalSetRawMode, this, [enabled]);
  record({ type: "raw_mode", enabled, isRaw: this.isRaw === true });
  if (enabled)
    queueMicrotask(() => {
      const readableListeners = this.listenerCount("readable");
      if (this.isRaw === true && readableListeners > 0)
        record({ type: "input_ready", isRaw: true, readableListeners });
    });
  return result;
};
const original = process.stdin.read;
process.stdin.read = function (...args) {
  const value = Reflect.apply(original, this, args);
  if (value !== null) {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    record({
      type: "read",
      sequence: ++sequence,
      hex: bytes.toString("hex"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return value;
};
