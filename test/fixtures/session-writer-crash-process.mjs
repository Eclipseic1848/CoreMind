import path from "node:path";
import { pathToFileURL } from "node:url";

// 真实持有两类正式锁；故意不运行 finally，交由父进程终止并验证死主回收。
const [modulePath, directory] = process.argv.slice(2);
if (!modulePath || !directory || !process.send) throw new Error("缺少崩溃验收 IPC 参数");
const { acquireSessionWriteLease, withSessionIO } = await import(
  pathToFileURL(path.resolve(modulePath)).href
);
const keepAlive = setInterval(() => undefined, 1_000);
try {
  const sessionDirectory = path.join(directory, "sessions");
  const writer = await acquireSessionWriteLease(sessionDirectory, "shared");
  await withSessionIO(sessionDirectory, "shared", async () => {
    await new Promise((resolve, reject) =>
      process.send(
        { type: "locked", pid: process.pid, sessionPath: writer.sessionPath },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    await new Promise(() => undefined);
  });
} catch (error) {
  clearInterval(keepAlive);
  if (process.connected) {
    await new Promise((resolve) =>
      process.send({ type: "error", code: error?.code ?? "unexpected_error" }, resolve),
    );
    process.disconnect();
  }
  process.exitCode = 1;
}
