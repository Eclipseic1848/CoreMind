import path from "node:path";
import { pathToFileURL } from "node:url";

// 由验收父进程 fork；仅导入已正式构建的 Runtime。
const [modulePath, directory, baseUrl, label] = process.argv.slice(2);
if (!modulePath || !directory || !baseUrl || !label || !process.send)
  throw new Error("缺少会话验收 IPC 参数");
const { CoreMindRuntime } = await import(pathToFileURL(path.resolve(modulePath)).href);
const controller = new AbortController();
let runtime;
let running;
let closing;
let attempt = 0;
const send = (message) =>
  new Promise((resolve, reject) => {
    if (!process.connected) return resolve();
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
const close = () =>
  (closing ??= (async () => {
    controller.abort();
    await running?.catch(() => undefined);
    const quiescent = runtime ? await runtime.waitForQuiescence() : true;
    await send({ type: "closed", pid: process.pid, quiescent });
    if (!quiescent) process.exitCode = 1;
    if (process.connected) process.disconnect();
  })());
process.on("message", (message) => {
  if (message?.type === "stop") {
    void close().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } else if (message?.type === "go" && runtime && !running && !closing) {
    const current = ++attempt;
    const operation = runtime.run();
    running = operation;
    void (async () => {
      let result;
      try {
        const run = await operation;
        result = {
          type: "done",
          attempt: current,
          status: run.outcome.status,
          finishReason: run.outcome.finishReason,
        };
      } catch (error) {
        result = {
          type: "done",
          attempt: current,
          rejected: true,
          code: error?.code ?? "unexpected_error",
        };
      }
      if (running === operation) running = undefined;
      await send(result);
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
      void close();
    });
  }
});
process.on("disconnect", () => {
  void close().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
});
try {
  runtime = await CoreMindRuntime.create({
    config: {
      schemaVersion: 2,
      name: "会话进程验收",
      provider: { id: "probe", model: "probe-model", baseUrl, apiKeyEnv: "COREMIND_TEST_API_KEY" },
      agents: { main: { tools: [] } },
      session: { enabled: true, compact: false },
      runtime: { maxTurns: 2, maxRetries: 0, runTimeoutMs: 6_000 },
    },
    configDir: directory,
    cwd: directory,
    sessionId: "shared",
    initialPrompt: label,
    signal: controller.signal,
  });
  await send({ type: "ready", pid: process.pid });
} catch (error) {
  await send({ type: "setup_error", code: error?.code ?? "unexpected_error" });
  process.exitCode = 1;
  await close();
}
