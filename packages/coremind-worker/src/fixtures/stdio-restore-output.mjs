import assert from "node:assert/strict";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const [stdioEntry, sdkEntry, checkpointId] = process.argv.slice(2);
assert.ok(path.isAbsolute(stdioEntry) && path.isAbsolute(sdkEntry) && checkpointId);
const sdk = await import(pathToFileURL(sdkEntry).href);
assert.equal(sdk.CheckpointManager, (await import("coremind-ai")).CheckpointManager);
const { WorkerServer } = await import(new URL("./server.js", pathToFileURL(stdioEntry)).href);
const { runStdioWorker } = await import(pathToFileURL(stdioEntry).href);
const send = (message) =>
  new Promise((resolve, reject) => {
    if (!process.connected) {
      resolve();
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const onMessage = (message) => {
  if (message.type === "release") release();
  if (message.type === "ping")
    void setImmediate()
      .then(() => send({ event: "pong" }))
      .catch(() => {});
};
const onDisconnect = () => {
  release();
  process.stdin.destroy();
};
process.on("message", onMessage);
process.once("disconnect", onDisconnect);

const originalRestore = sdk.CheckpointManager.prototype.restore;
sdk.CheckpointManager.prototype.restore = async function (...args) {
  if (args[0] === checkpointId) {
    await send({ event: "restore_entered" });
    await gate;
  }
  // 门闩只控制时序；实际校验、workspace lease 和磁盘恢复仍由原方法完成。
  return originalRestore.apply(this, args);
};
const originalShutdown = WorkerServer.prototype.shutdown;
WorkerServer.prototype.shutdown = async function (...args) {
  const result = await originalShutdown.apply(this, args);
  // 不用 IPC 写入阻塞原 shutdown 返回；观察安排在其 Promise 续体之后。
  process.nextTick(() => {
    void send({ event: "shutdown_returned", quiescent: result.quiescent }).catch(() => {});
  });
  return result;
};
try {
  await send({ event: "ready" });
  await runStdioWorker();
  await send({ event: "completion_succeeded" });
} catch (error) {
  await send({ event: "completion_failed", code: error?.code });
  console.error(`${error?.code ?? "fixture_failed"}: restore 输出故障探针结束`);
  process.exitCode = 1;
} finally {
  sdk.CheckpointManager.prototype.restore = originalRestore;
  WorkerServer.prototype.shutdown = originalShutdown;
  process.off("message", onMessage);
  process.off("disconnect", onDisconnect);
  if (process.connected) process.disconnect();
}
